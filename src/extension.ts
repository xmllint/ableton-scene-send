import {
  initialize,
  type ActivationContext,
  type Handle,
  MidiClip,
  AudioClip,
  MidiTrack,
  AudioTrack,
  Scene,
} from "@ableton-extensions/sdk";

/**
 * SceneSend — Right-click a Scene row and copy every clip in that row
 * into the Arrangement at a chosen cue point (locator).
 *
 * Session clips stay put — this is a copy operation.
 */

// Maps commandId → { time (beats), cueName }
const cueRegistry = new Map<string, { time: number; name: string }>();

export function activate(activation: ActivationContext) {
  // Defer for .ablx startup safety
  setTimeout(() => {
    try {
      cueRegistry.clear();

      const context = initialize(activation, "1.0.0");
      const song = context.application.song;

      // ── Enumerate named cue points ────────────────────
      const namedCues = song.cuePoints.filter(
        (c) => c.name.trim().length > 0,
      );

      if (namedCues.length === 0) {
        console.warn(
          "[SceneSend] No named locators found. Add some in Arrangement " +
          "then restart the extension (or reload Live).",
        );
        console.log("[SceneSend] Ready — 0 cue points (idle)");
        return;
      }

      for (const cue of namedCues) {
        const cueName = cue.name.trim();
        const cmdId = `sceneSend.${cue.handle.id}`;
        const label = `▶ Send to «${cueName}»`;

        cueRegistry.set(cmdId, { time: cue.time, name: cueName });

        // Register menu action — log if IPC round-trip fails
        context.ui
          .registerContextMenuAction("Scene", label, cmdId)
          .catch((err) =>
            console.error(
              `[SceneSend] Failed to register menu for «${cueName}»:`, err,
            ),
          );

        context.commands.registerCommand(cmdId, (arg: unknown) =>
          void (async (handle: Handle) => {
            const entry = cueRegistry.get(cmdId);
            if (!entry) {
              console.error(`[SceneSend] Unknown command: ${cmdId}`);
              return;
            }

            try {
              // 1. Resolve the Scene and find its index
              const scene = context.getObjectFromHandle(handle, Scene);
              const sceneIndex = song.scenes.findIndex(
                (s) => s.handle.id === scene.handle.id,
              );
              if (sceneIndex < 0) {
                console.error("[SceneSend] Scene not found in song");
                return;
              }

              const targetBeat = entry.time;
              let copiedCount = 0;

              // 2. Copy all clips — sequential to avoid IPC contention
              for (const track of song.tracks) {
                try {
                  const slot = track.clipSlots[sceneIndex];
                  if (!slot) continue;

                  const clip = slot.clip;
                  if (!clip) continue;

                  if (clip instanceof MidiClip && track instanceof MidiTrack) {
                    await copyMidiToArrangement(clip, track, targetBeat);
                    copiedCount++;
                  } else if (
                    clip instanceof AudioClip &&
                    track instanceof AudioTrack
                  ) {
                    await copyAudioToArrangement(clip, track, targetBeat);
                    copiedCount++;
                  }
                } catch (err) {
                  console.error(
                    `[SceneSend] Failed on track "${track.name}":`, err,
                  );
                }
              }

              console.log(
                `[SceneSend] Scene → «${entry.name}»: ` +
                `${copiedCount} clip${copiedCount === 1 ? "" : "s"} ` +
                `copied @ ${targetBeat.toFixed(1)} beats`,
              );
            } catch (err) {
              console.error("[SceneSend] Failed:", err);
            }
          })(arg as Handle).catch((err) =>
            console.error("[SceneSend] Unhandled:", err),
          ),
        );
      }

      console.log(
        `[SceneSend] Ready — ${cueRegistry.size} cue point` +
        `${cueRegistry.size === 1 ? "" : "s"}`,
      );
    } catch (err) {
      console.error("[SceneSend] activate() crashed:", err);
    }
  }, 500);
}

// ── MIDI: copy clip to arrangement ──
async function copyMidiToArrangement(
  clip: MidiClip<"1.0.0">,
  track: MidiTrack<"1.0.0">,
  targetBeat: number,
): Promise<void> {
  const notes = clip.notes;
  const name = clip.name;
  const color = clip.color;

  // Session MIDI clips can be open-ended — clip.duration may return
  // a large negative number. Derive the real length from note content.
  const noteEnds = notes.map((n) => n.startTime + n.duration);
  const maxNoteEnd = noteEnds.length > 0 ? Math.max(...noteEnds) : 0;
  const duration =
    clip.duration > 0
      ? Math.max(clip.duration, maxNoteEnd)
      : maxNoteEnd || 4;

  console.log(
    `[SceneSend] MIDI: track="${track.name}" start=${targetBeat} ` +
    `clipDur=${clip.duration} derived=${duration.toFixed(1)} ` +
    `notes=${notes.length}`,
  );

  const newClip = await track.createMidiClip(targetBeat, duration);
  newClip.name = name;
  newClip.color = color;
  newClip.notes = notes;
}

// ── Audio: copy clip to arrangement ──
async function copyAudioToArrangement(
  clip: AudioClip<"1.0.0">,
  track: AudioTrack<"1.0.0">,
  targetBeat: number,
): Promise<void> {
  const filePath = clip.filePath;
  const name = clip.name;
  const color = clip.color;
  const warping = clip.warping;
  const warpMode = clip.warpMode;

  // Audio clips with negative duration (open-ended, or just never set)
  // are safe to fall back to 1 bar — Live extends the clip to the
  // sample's natural length automatically when warping is on.
  const duration = clip.duration > 0 ? clip.duration : 4;

  console.log(
    `[SceneSend] Audio: track="${track.name}" ` +
    `path="${filePath}" start=${targetBeat} dur=${duration}`,
  );

  const newClip = await track.createAudioClip({
    filePath,
    startTime: targetBeat,
    duration,
    isWarped: warping,
  });
  newClip.name = name;
  newClip.color = color;
  newClip.warpMode = warpMode;
}
