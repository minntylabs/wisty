//! Sentence playback for an open .tsf: decode a span of the recording and play
//! it, so a doubtful passage can be checked against what was actually said.
//!
//! The recording is already in memory — tsf.rs reads the audio member on open
//! and holds it for the document's lifetime — so nothing here touches the disk.
//!
//! The division of labour with the frontend is deliberate and worth stating,
//! because it is the thing most likely to be undone by accident: this side
//! receives ABSOLUTE SECONDS and holds no policy. The head and tail padding
//! that makes a snippet listenable (§3.5 of the plan) is the editor's business
//! and is already applied to the numbers arriving here. Moving it down here
//! would put a listening decision in the audio plumbing, where the reason for
//! its size — Whisper's word timings run short — is invisible.
//!
//! Spans are cut as samples rather than timed: symphonia decodes the range and
//! hands rodio a finished buffer, so the boundaries are exact and rodio only
//! ever drives the device. A span that stopped by timer would drift, and the
//! failure would be inaudible until it was wrong by a word.

use std::io::Cursor;
use std::sync::{Arc, Mutex};

use rodio::buffer::SamplesBuffer;
use rodio::stream::MixerDeviceSink;
use rodio::{ChannelCount, Player, SampleRate};
use symphonia::core::audio::GenericAudioBufferRef;
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::codecs::CodecParameters;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::Time;

/// The recording, shared rather than copied.
///
/// `Cursor` gives `Read + Seek`, and symphonia has a blanket `MediaSource` impl
/// for any `Cursor<T: AsRef<[u8]>>`. The newtype exists only to supply that
/// `AsRef`, which `Arc<[u8]>` does not have on its own. Without it every play
/// would clone ten megabytes to build a reader.
#[derive(Clone)]
struct SharedAudio(Arc<[u8]>);

impl AsRef<[u8]> for SharedAudio {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

/// A decoded span, ready for the device.
///
/// Rate and channel count are the non-zero types rodio asks for, so the "did
/// this decode to actual audio" check happens once, here, rather than being
/// re-asserted by a panic inside SamplesBuffer.
struct DecodedSpan {
    samples: Vec<f32>,
    rate: SampleRate,
    channels: ChannelCount,
}

/// Which decoded frames belong to the requested span.
///
/// An accurate seek lands at or before the requested time — never after, which
/// is the right direction to fail in, since a head pad already exists and an
/// early landing cannot clip a first word. So decoding starts slightly early
/// and the excess is dropped here.
///
/// Returned in frames rather than samples because the channel count is a
/// property of the decode, not of the request, and multiplying in one place is
/// harder to get wrong than carrying interleaved indices around.
///
/// Pure, and separated from the decoding for exactly one reason: playing the
/// wrong passage is a silent failure. This is where that bug would live, so it
/// is the part that gets tested against known offsets rather than by ear.
fn span_frames(seek_secs: f64, start_secs: f64, end_secs: f64, rate: u32) -> (usize, usize) {
    let rate = f64::from(rate);
    // A seek landing after the requested start would mean the span's opening is
    // already gone; clamping to zero plays from as early as the file allows,
    // which is the best available answer and never plays the wrong thing.
    let skip = ((start_secs - seek_secs).max(0.0) * rate).round() as usize;
    let take = ((end_secs - start_secs).max(0.0) * rate).round() as usize;
    (skip, take)
}

/// Decodes [start, end) seconds of `audio`.
fn decode_span(audio: SharedAudio, start: f64, end: f64) -> Result<DecodedSpan, String> {
    let stream = MediaSourceStream::new(Box::new(Cursor::new(audio)), Default::default());
    let mut reader = symphonia::default::get_probe()
        .probe(
            &Hint::new(),
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|error| format!("Unrecognised audio format: {error}"))?;

    let track = reader
        .tracks()
        .iter()
        .find(|track| {
            track
                .codec_params
                .as_ref()
                .is_some_and(CodecParameters::is_audio)
        })
        .ok_or_else(|| "The recording contains no audio track".to_string())?;
    let track_id = track.id;
    let time_base = track
        .time_base
        .ok_or_else(|| "The audio track has no timebase".to_string())?;
    let Some(CodecParameters::Audio(params)) = track.codec_params.as_ref() else {
        return Err("The audio track has no codec parameters".to_string());
    };
    let mut decoder: Box<dyn AudioDecoder> = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|error| format!("Cannot decode this recording: {error}"))?;

    let seeked = reader
        .seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time: Time::try_from_secs_f64(start)
                    .ok_or_else(|| format!("{start} is not a usable time"))?,
                track_id: Some(track_id),
            },
        )
        .map_err(|error| format!("Cannot seek to {start:.2}s: {error}"))?;
    // Required after any seek: the next packet is discontinuous with the last
    // one the decoder saw, and without this the first frames are rubbish.
    decoder.reset();

    let seek_secs = time_base
        .calc_time(seeked.actual_ts)
        .ok_or_else(|| "The seek landed outside the recording".to_string())?
        .as_secs_f64();

    let mut samples: Vec<f32> = Vec::new();
    let mut rate = 0u32;
    let mut channels = 0u16;
    let mut wanted: Option<(usize, usize)> = None;

    loop {
        let packet = match reader.next_packet() {
            Ok(Some(packet)) => packet,
            // End of file: the span runs to the end of the recording, which is
            // ordinary for the last sentence plus its tail pad.
            Ok(None) => break,
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(error) => return Err(format!("Cannot read the recording: {error}")),
        };
        if packet.track_id != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            // One bad packet is recoverable by contract and is not worth
            // refusing to play a sentence over.
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(error) => return Err(format!("Cannot decode the recording: {error}")),
        };

        // The decoded rate is not the declared rate: symphonia's AAC decoder is
        // LC-only, so an HE-AAC file decodes at half its declared rate and in
        // mono. Both are fine here (12 kHz of bandwidth, speech) but it means
        // the frame arithmetic must use what came out, never what was claimed.
        if wanted.is_none() {
            let spec = decoded.spec();
            rate = spec.rate();
            channels = spec.channels().count() as u16;
            if rate == 0 || channels == 0 {
                return Err("The recording decoded to no audio".to_string());
            }
            wanted = Some(span_frames(seek_secs, start, end, rate));
        }
        append_interleaved(&decoded, &mut samples);

        let (skip, take) = wanted.unwrap_or((0, 0));
        if samples.len() >= (skip + take) * usize::from(channels) {
            break;
        }
    }

    let (skip, take) = wanted.ok_or_else(|| "The recording decoded to nothing".to_string())?;
    let stride = usize::from(channels);
    let from = (skip * stride).min(samples.len());
    let to = (from + take * stride).min(samples.len());

    Ok(DecodedSpan {
        samples: samples[from..to].to_vec(),
        rate: SampleRate::new(rate).ok_or_else(|| "The recording decoded at no sample rate".to_string())?,
        channels: ChannelCount::new(channels)
            .ok_or_else(|| "The recording decoded to no channels".to_string())?,
    })
}

fn append_interleaved(decoded: &GenericAudioBufferRef<'_>, samples: &mut Vec<f32>) {
    let mut block: Vec<f32> = Vec::with_capacity(decoded.samples_interleaved());
    decoded.copy_to_vec_interleaved(&mut block);
    samples.append(&mut block);
}

/// The device and the recording, alive for as long as a container is open.
///
/// The output stream is built once and kept: opening a device takes long enough
/// to be heard as a delay on the first click, and rebuilding it per span would
/// pay that every time.
struct Playing {
    /// Never read after construction, but dropping it closes the device and
    /// silences the player, so it has to outlive the player it feeds.
    _device: MixerDeviceSink,
    player: Player,
    audio: SharedAudio,
}

#[derive(Default)]
/// Private field on purpose: unlike TsfState, whose audio this module reads,
/// nothing outside here has any business holding the device or the player.
pub struct PlaybackState(Mutex<Option<Playing>>);

impl PlaybackState {
    fn with_player<T>(
        &self,
        run: impl FnOnce(&mut Option<Playing>) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self
            .0
            .lock()
            .map_err(|error| format!("Cannot take the playback lock: {error}"))?;
        run(&mut guard)
    }
}

/// Plays [start, end) seconds of the open container's recording.
///
/// Both times are absolute seconds into the recording, with §3.5's padding
/// already applied by the caller. Any span already playing is replaced, because
/// clicking a second sentence while the first is still going is the normal way
/// this gets used.
#[tauri::command]
pub fn play_span(
    playback: tauri::State<'_, PlaybackState>,
    container: tauri::State<'_, crate::tsf::TsfState>,
    start: f64,
    end: f64,
) -> Result<(), String> {
    if !start.is_finite() || !end.is_finite() {
        return Err(format!("A span needs finite times, got {start} and {end}"));
    }
    if end <= start {
        return Err(format!("A span must end after it starts, got {start} to {end}"));
    }

    playback.with_player(|slot| {
        if slot.is_none() {
            let audio = {
                let open = container
                    .0
                    .lock()
                    .map_err(|error| format!("Cannot take the open-container lock: {error}"))?;
                let open = open
                    .as_ref()
                    .ok_or_else(|| "No transcript container is open".to_string())?;
                SharedAudio(Arc::from(open.audio.as_slice()))
            };
            let device = rodio::stream::DeviceSinkBuilder::open_default_sink()
                .map_err(|error| format!("Cannot open an audio output device: {error}"))?;
            let player = Player::connect_new(device.mixer());
            *slot = Some(Playing {
                _device: device,
                player,
                audio,
            });
        }

        let player = slot.as_mut().expect("just constructed");
        let span = decode_span(player.audio.clone(), start, end)?;
        // Replaces whatever was playing. stop() returns effectively at once —
        // the queue clears within about a frame — so this is not audible as a
        // gap when clicking from one sentence to the next.
        player.player.stop();
        player
            .player
            .append(SamplesBuffer::new(span.channels, span.rate, span.samples));
        player.player.play();
        Ok(())
    })
}

/// Stops whatever is playing. Harmless when nothing is.
#[tauri::command]
pub fn stop_playback(playback: tauri::State<'_, PlaybackState>) -> Result<(), String> {
    playback.with_player(|slot| {
        if let Some(playing) = slot.as_ref() {
            playing.player.stop();
        }
        Ok(())
    })
}

/// Releases the device and the recording.
///
/// Called when the document closes, alongside tsf::close_tsf. Playback must not
/// outlive the document it belongs to — audio still playing from a transcript
/// the user has closed is both confusing and a way to keep ten megabytes
/// resident after they have moved on.
#[tauri::command]
pub fn release_playback(playback: tauri::State<'_, PlaybackState>) -> Result<(), String> {
    playback.with_player(|slot| {
        if let Some(playing) = slot.take() {
            playing.player.stop();
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::{decode_span, span_frames, SharedAudio};
    use std::sync::Arc;

    const RATE: u32 = 8000;

    /// A ten-second WAV in which every second holds a different constant level:
    /// second 0 is 1000, second 1 is 2000, and so on.
    ///
    /// That is the whole point. The dangerous failure in this module is playing
    /// the wrong passage, which is silent — the audio sounds fine, it is just
    /// not the sentence that was clicked. Ordinary audio cannot catch that in a
    /// test, but audio that says which second it came from can.
    ///
    /// WAV rather than the AAC a real container holds, because symphonia reads
    /// it with no optional feature and it needs no fixture file or ffmpeg. The
    /// arithmetic under test is codec-independent.
    fn stepped_wav() -> SharedAudio {
        const SECONDS: u32 = 10;
        let frames = RATE * SECONDS;
        let data_len = frames * 2;
        let mut out = Vec::with_capacity(44 + data_len as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&RATE.to_le_bytes());
        out.extend_from_slice(&(RATE * 2).to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        for frame in 0..frames {
            let second = frame / RATE;
            let level = ((second + 1) * 1000) as i16;
            out.extend_from_slice(&level.to_le_bytes());
        }
        SharedAudio(Arc::from(out.as_slice()))
    }

    /// Which second a decoded sample came from, by its level.
    fn second_of(sample: f32) -> u32 {
        (sample * 32768.0 / 1000.0).round() as u32 - 1
    }

    #[test]
    fn decodes_the_second_that_was_asked_for() {
        let span = decode_span(stepped_wav(), 3.0, 4.0).expect("decode");
        assert_eq!(span.rate.get(), RATE);
        assert_eq!(span.channels.get(), 1);
        assert_eq!(span.samples.len(), RATE as usize);
        // Every sample, not just the first: a span that started right and ran
        // long would still be the wrong thing to hear.
        assert!(
            span.samples.iter().all(|&sample| second_of(sample) == 3),
            "span strayed outside second 3"
        );
    }

    #[test]
    fn decodes_a_span_that_crosses_a_boundary_in_order() {
        let span = decode_span(stepped_wav(), 6.5, 7.5).expect("decode");
        assert_eq!(span.samples.len(), RATE as usize);
        let half = RATE as usize / 2;
        assert!(span.samples[..half].iter().all(|&s| second_of(s) == 6));
        assert!(span.samples[half..].iter().all(|&s| second_of(s) == 7));
    }

    /// Every second of the file, so an error that only shows up after a long
    /// seek — the case a spot check at the start would miss — is caught.
    #[test]
    fn lands_on_the_right_second_throughout_the_file() {
        let audio = stepped_wav();
        for second in 0..10 {
            let span = decode_span(audio.clone(), f64::from(second), f64::from(second) + 0.5)
                .unwrap_or_else(|error| panic!("decode at {second}s: {error}"));
            assert!(
                span.samples.iter().all(|&s| second_of(s) == second),
                "span at {second}s decoded the wrong passage"
            );
        }
    }

    /// The last sentence plus its tail pad runs past the end of the recording.
    /// That is ordinary, and must return what exists rather than fail.
    #[test]
    fn truncates_a_span_running_past_the_end() {
        let span = decode_span(stepped_wav(), 9.5, 12.0).expect("decode");
        assert!(!span.samples.is_empty());
        assert!(span.samples.len() <= (RATE as usize) / 2);
        assert!(span.samples.iter().all(|&s| second_of(s) == 9));
    }


    /// The seek landed exactly where it was asked to.
    #[test]
    fn takes_the_whole_span_when_the_seek_is_exact() {
        assert_eq!(span_frames(10.0, 10.0, 12.0, 24_000), (0, 48_000));
    }

    /// The ordinary case: an accurate seek lands at or before the request.
    #[test]
    fn drops_the_frames_decoded_before_the_span_starts() {
        assert_eq!(span_frames(9.5, 10.0, 12.0, 24_000), (12_000, 48_000));
    }

    /// A seek landing late cannot be corrected by skipping, and skipping a
    /// negative number of frames would wrap. Play from as early as possible.
    #[test]
    fn never_skips_backwards_when_the_seek_overshoots() {
        assert_eq!(span_frames(10.5, 10.0, 12.0, 24_000), (0, 48_000));
    }

    /// The rate is the decoded rate, which for HE-AAC is half the declared one.
    #[test]
    fn counts_frames_at_the_decoded_rate() {
        assert_eq!(span_frames(0.0, 1.0, 2.0, 48_000).1, 48_000);
        assert_eq!(span_frames(0.0, 1.0, 2.0, 24_000).1, 24_000);
    }

    /// Sub-millisecond spans round rather than truncating to nothing.
    #[test]
    fn rounds_to_the_nearest_frame() {
        // 0.00001s at 24 kHz is 0.24 frames, and half a frame is inaudible
        // either way; what matters is that it is not a panic or a wrap.
        assert_eq!(span_frames(0.0, 0.0, 0.00001, 24_000), (0, 0));
        assert_eq!(span_frames(0.0, 0.0, 0.0001, 24_000), (0, 2));
    }

    /// A span whose end precedes its start is rejected by the command, but the
    /// arithmetic must not wrap if one ever reaches here.
    #[test]
    fn yields_an_empty_span_rather_than_wrapping() {
        assert_eq!(span_frames(0.0, 5.0, 4.0, 24_000), (120_000, 0));
    }
}
