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
  console.log("[SceneSend] activate() called");

  // Defer for .ablx startup safety
  setTimeout(() => {
    console.log("[SceneSend] Deferred init starting");
    try {
      cueRegistry.clear();

      const context = initialize(activation, "1.0.0");
      const song = context.application.song;
      console.log("[SceneSend] Song resolved");

      // ── Enumerate named cue points ────────────────────
      const allCues = song.cuePoints;
      console.log(`[SceneSend] Total locators: ${allCues.length}`);

      const namedCues = allCues.filter(
        (c) => c.name.trim().length > 0,
      );
      console.log(`[SceneSend] Named locators: ${namedCues.length}`);

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
        const cueTime = cue.time;
        const cmdId = `sceneSend.${cue.handle.id}`;
        const label = `▶ Send to «${cueName}»`;

        console.log(
          `[SceneSend] Registering: "${label}" → cmd=${cmdId} ` +
          `time=${cueTime.toFixed(1)}`,
        );

        cueRegistry.set(cmdId, { time: cueTime, name: cueName });

        context.ui
          .registerContextMenuAction("Scene", label, cmdId)
          .catch((err) =>
            console.error(
              `[SceneSend] Menu FAILED for «${cueName}»:`, err,
            ),
          );

        context.commands.registerCommand(cmdId, (arg: unknown) =>
          void (async (handle: Handle) => {
            const entry = cueRegistry.get(cmdId);
            if (!entry) {
              console.error(`[SceneSend] Unknown command: ${cmdId}`);
              return;
            }

            console.log(
              `[SceneSend] >>> TRIGGER: Send to «${entry.name}» ` +
              `@ ${entry.time.toFixed(1)} beats <<<`,
            );

            try {
              // 1. Resolve the Scene and find its index
              console.log("[SceneSend] Resolving scene handle...");
              const scene = context.getObjectFromHandle(handle, Scene);
              console.log(`[SceneSend] Scene resolved, name="${scene.name}"`);

              const sceneIndex = song.scenes.findIndex(
                (s) => s.handle.id === scene.handle.id,
              );
              console.log(
                `[SceneSend] Scene index=${sceneIndex} ` +
                `(of ${song.scenes.length} total scenes)`,
              );

              if (sceneIndex < 0) {
                console.error("[SceneSend] Scene not found in song");
                return;
              }

              const targetBeat = entry.time;
              let copiedCount = 0;
              let skippedNoSlot = 0;
              let skippedEmpty = 0;
              let skippedTypeMismatch = 0;

              console.log(
                `[SceneSend] Walking ${song.tracks.length} tracks ` +
                `at scene index ${sceneIndex}...`,
              );

              // 2. Copy all clips — sequential to avoid IPC contention
              for (const track of song.tracks) {
                const trackName = track.name;
                try {
                  const slot = track.clipSlots[sceneIndex];
                  if (!slot) {
                    console.log(
                      `[SceneSend]   SKIP "${trackName}": no clip slot`,
                    );
                    skippedNoSlot++;
                    continue;
                  }

                  const clip = slot.clip;
                  if (!clip) {
                    console.log(
                      `[SceneSend]   SKIP "${trackName}": empty slot`,
                    );
                    skippedEmpty++;
                    continue;
                  }

                  const clipName = clip.name || "(unnamed)";

                  if (
                    clip instanceof MidiClip &&
                    track instanceof MidiTrack
                  ) {
                    console.log(
                      `[SceneSend]   MIDI "${trackName}" / "${clipName}" → ` +
                      `copying...`,
                    );
                    await copyMidiToArrangement(
                      clip, track, targetBeat,
                    );
                    copiedCount++;
                    console.log(
                      `[SceneSend]   MIDI "${trackName}" / "${clipName}" ✓`,
                    );
                  } else if (
                    clip instanceof AudioClip &&
                    track instanceof AudioTrack
                  ) {
                    console.log(
                      `[SceneSend]   AUDIO "${trackName}" / "${clipName}" → ` +
                      `copying...`,
                    );
                    await copyAudioToArrangement(
                      clip, track, targetBeat,
                    );
                    copiedCount++;
                    console.log(
                      `[SceneSend]   AUDIO "${trackName}" / "${clipName}" ✓`,
                    );
                  } else {
                    console.log(
                      `[SceneSend]   SKIP "${trackName}": ` +
                      `type mismatch (clip type != track type)`,
                    );
                    skippedTypeMismatch++;
                  }
                } catch (err) {
                  console.error(
                    `[SceneSend]   ERROR on track "${trackName}":`, err,
                  );
                }
              }

              console.log(
                `[SceneSend] <<< DONE: ${copiedCount} copied, ` +
                `${skippedNoSlot} no-slot, ${skippedEmpty} empty, ` +
                `${skippedTypeMismatch} type-mismatch >>>`,
              );
            } catch (err) {
              console.error("[SceneSend] FATAL:", err);
            }
          })(arg as Handle).catch((err) =>
            console.error("[SceneSend] Unhandled rejection:", err),
          ),
        );
      }

      console.log(
        `[SceneSend] Ready — ${cueRegistry.size} cue point` +
        `${cueRegistry.size === 1 ? "" : "s"} registered`,
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

  const noteStarts = notes.map((n) => n.startTime);
  const noteEnds = notes.map((n) => n.startTime + n.duration);
  const minStart = noteStarts.length > 0 ? Math.min(...noteStarts) : 0;
  const maxEnd = noteEnds.length > 0 ? Math.max(...noteEnds) : 0;

  const duration =
    clip.duration > 0
      ? Math.max(clip.duration, maxEnd)
      : maxEnd || 4;

  console.log(
    `[SceneSend]     clip.duration=${clip.duration} ` +
    `derived=${duration.toFixed(1)} notes=${notes.length} ` +
    `noteRange=[${minStart.toFixed(1)}–${maxEnd.toFixed(1)}]`,
  );

  console.log(
    `[SceneSend]     → createMidiClip(start=${targetBeat}, dur=${duration.toFixed(1)})`,
  );
  const newClip = await track.createMidiClip(targetBeat, duration);
  console.log(`[SceneSend]     createMidiClip ✓`);

  newClip.name = name;
  newClip.color = color;
  console.log(`[SceneSend]     → set notes (${notes.length} notes)`);
  newClip.notes = notes;
  console.log(`[SceneSend]     set notes ✓`);
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
  const duration = clip.duration > 0 ? clip.duration : 4;

  console.log(
    `[SceneSend]     filePath="${filePath}" ` +
    `clip.dur=${clip.duration} using=${duration} ` +
    `warping=${warping} warpMode=${warpMode}`,
  );

  console.log(
    `[SceneSend]     → createAudioClip(start=${targetBeat}, dur=${duration})`,
  );
  const newClip = await track.createAudioClip({
    filePath,
    startTime: targetBeat,
    duration,
    isWarped: warping,
  });
  console.log(`[SceneSend]     createAudioClip ✓`);

  newClip.name = name;
  newClip.color = color;
  newClip.warpMode = warpMode;
  console.log(`[SceneSend]     name/color/warpMode set ✓`);
}
