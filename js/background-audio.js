// ===== Background Sounds =====
// Generates looping "brainwave" background sounds with the Web Audio API — no
// audio files, works offline, loops forever. Each sound is a binaural beat: two
// slightly detuned tones (one per stereo channel) whose frequency difference is
// the target brainwave rate the brain tends to entrain toward.
//
//   Theta (~6 Hz beat): relaxed focus, meditation, flow.
//   Delta (~2 Hz beat): deep rest / calm.
//
// Binaural beats need stereo separation (headphones) to be perceived properly.
(function () {
    const VOL_KEY = 'bgSoundVolume';
    const LAST_KEY = 'bgSoundLast';

    // Sound presets. carrier = base tone (Hz); beat = L/R difference (Hz).
    const SOUNDS = {
        theta: { label: 'Theta waves', carrier: 200, beat: 6 },
        delta: { label: 'Delta waves', carrier: 150, beat: 2 }
    };

    let audioCtx = null;
    let leftOsc = null;
    let rightOsc = null;
    let masterGain = null;
    let merger = null;
    let activeSound = null; // key of the currently playing sound, or null

    // ----- DOM refs (resolved on init) -----
    let statusEl, volumeRow, volumeSlider, buttons = [];

    // ----- UI helpers -----
    function setStatus(text, playing) {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.classList.toggle('playing', !!playing);
    }

    function getSavedVolume() {
        const v = (typeof loadData === 'function') ? loadData(VOL_KEY, 40) : 40;
        const n = parseInt(v, 10);
        return isNaN(n) ? 40 : Math.max(0, Math.min(100, n));
    }

    // Map a 0-100 slider to a gentle gain. Binaural tones are fatiguing loud, so
    // we cap the top end well below 1.0.
    function volumeToGain(vol) {
        const v = Math.max(0, Math.min(100, vol));
        return (v / 100) * 0.25;
    }

    function refreshButtons() {
        buttons.forEach(btn => {
            const isActive = btn.dataset.sound === activeSound;
            btn.classList.toggle('active', isActive);
            btn.textContent = isActive ? `\u25A0 ${SOUNDS[btn.dataset.sound].label}` : SOUNDS[btn.dataset.sound].label;
        });
        if (volumeRow) volumeRow.style.display = activeSound ? 'flex' : 'none';
    }

    // ----- Audio graph -----
    function ensureContext() {
        if (!audioCtx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            audioCtx = new Ctx();
        }
        // Autoplay policies suspend the context until a user gesture; a button
        // click is that gesture, so resume here.
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    }

    function play(soundKey) {
        const preset = SOUNDS[soundKey];
        if (!preset) return;

        // Toggle off if the same sound is tapped again.
        if (activeSound === soundKey) {
            stop();
            return;
        }

        const ctx = ensureContext();
        stopNodes(); // clear any currently-playing sound

        masterGain = ctx.createGain();
        masterGain.gain.value = volumeToGain(getSavedVolume());
        masterGain.connect(ctx.destination);

        // Route the two oscillators to separate stereo channels so the beat is
        // perceived binaurally (left ear vs right ear).
        merger = ctx.createChannelMerger(2);
        merger.connect(masterGain);

        const half = preset.beat / 2;

        leftOsc = ctx.createOscillator();
        leftOsc.type = 'sine';
        leftOsc.frequency.value = preset.carrier - half;
        leftOsc.connect(merger, 0, 0); // left channel

        rightOsc = ctx.createOscillator();
        rightOsc.type = 'sine';
        rightOsc.frequency.value = preset.carrier + half;
        rightOsc.connect(merger, 0, 1); // right channel

        // Gentle fade-in to avoid a click.
        const now = ctx.currentTime;
        masterGain.gain.setValueAtTime(0.0001, now);
        masterGain.gain.exponentialRampToValueAtTime(
            Math.max(0.0001, volumeToGain(getSavedVolume())), now + 0.4
        );

        leftOsc.start();
        rightOsc.start();

        activeSound = soundKey;
        setStatus(`Playing · ${preset.label}`, true);
        refreshButtons();

        if (typeof saveData === 'function') saveData(LAST_KEY, soundKey);
    }

    function stopNodes() {
        [leftOsc, rightOsc].forEach(osc => {
            if (osc) {
                try { osc.stop(); } catch (e) {}
                try { osc.disconnect(); } catch (e) {}
            }
        });
        if (merger) { try { merger.disconnect(); } catch (e) {} }
        if (masterGain) { try { masterGain.disconnect(); } catch (e) {} }
        leftOsc = rightOsc = merger = masterGain = null;
    }

    function stop() {
        stopNodes();
        activeSound = null;
        setStatus('Off', false);
        refreshButtons();
    }

    function setVolume(vol) {
        const v = Math.max(0, Math.min(100, parseInt(vol, 10) || 0));
        if (masterGain && audioCtx) {
            // Smooth the change so it doesn't crackle.
            masterGain.gain.setTargetAtTime(volumeToGain(v), audioCtx.currentTime, 0.05);
        }
        if (typeof saveData === 'function') saveData(VOL_KEY, v);
    }

    // ----- Wire up -----
    function init() {
        statusEl = document.getElementById('bg-audio-status');
        volumeRow = document.getElementById('bg-audio-volume-row');
        volumeSlider = document.getElementById('bg-audio-volume');
        buttons = Array.prototype.slice.call(document.querySelectorAll('.bg-sound-btn'));

        if (buttons.length === 0) return; // section not present

        if (volumeSlider) volumeSlider.value = String(getSavedVolume());

        buttons.forEach(btn => {
            btn.addEventListener('click', () => play(btn.dataset.sound));
        });

        if (volumeSlider) {
            volumeSlider.addEventListener('input', () => setVolume(volumeSlider.value));
        }

        refreshButtons();
        setStatus('Off', false);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
