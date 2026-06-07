import {
  initialize,
  type ActivationContext,
  type Handle,
  type NoteDescription,
  MidiClip,
  AudioClip,
  MidiTrack,
  AudioTrack,
  Scene,
} from "@ableton-extensions/sdk";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface CueEntry {
  index: number;
  name: string;
  time: number;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildPickerModal(cues: CueEntry[]): string {
  const items = cues
    .map(
      (c) =>
        `<button class="row" onclick="select(${c.index})">` +
        `<span class="name">${esc(c.name)}</span>` +
        `<span class="time">${c.time.toFixed(1)} beats</span>` +
        `</button>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Send to Locator</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:#0f0f13;color:#e4e4e7;padding:14px 16px;
    user-select:none;-webkit-user-select:none;
  }
  h2{font-size:14px;font-weight:600;margin-bottom:10px}
  .options{
    background:#1a1a20;border:1px solid #27272a;border-radius:6px;
    padding:8px 10px;margin-bottom:10px;display:flex;flex-direction:column;gap:6px;
  }
  .opt{display:flex;align-items:center;gap:7px;font-size:11px;color:#a1a1aa;cursor:pointer}
  .opt input{accent-color:#a78bfa;cursor:pointer}
  .cues{margin-bottom:10px}
  .row{
    display:flex;justify-content:space-between;align-items:center;
    width:100%;padding:8px 10px;margin-bottom:4px;
    background:#1a1a20;border:1px solid #27272a;border-radius:6px;
    cursor:pointer;color:#e4e4e7;font-family:inherit;font-size:12px;
    transition:all .1s;
  }
  .row:hover{background:#22222b;border-color:#a78bfa}
  .row:active{transform:scale(.98)}
  .name{font-weight:500}
  .time{font-size:10px;color:#71717a}
  .empty{padding:20px;text-align:center;color:#52525b;font-size:12px}
  .btn-row{display:flex;justify-content:flex-end}
  .btn-cancel{
    background:transparent;border:1px solid #3f3f46;color:#a1a1aa;
    border-radius:6px;padding:6px 14px;font-size:11px;cursor:pointer;
    font-family:inherit;transition:all .1s;
  }
  .btn-cancel:hover{background:#27272a;border-color:#52525b;color:#e4e4e7}
</style></head>
<body>
  <h2>Send Scene to Locator</h2>
  <div class="options">
    <label class="opt"><input type="checkbox" id="doLoop" checked> Loop clips until next locator</label>
    <label class="opt"><input type="checkbox" id="doCut" checked> Cut clips at next locator</label>
  </div>
  <div class="cues">
    ${cues.length > 0 ? items : '<div class="empty">No named locators found.<br>Add some in Arrangement View.</div>'}
  </div>
  <div class="btn-row"><button class="btn-cancel" onclick="cancel()">Cancel</button></div>
  <script>
    // Cross-platform postMessage — WebView2 (Windows) vs WKWebView (macOS)
    function post(msg) {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage(msg);
      } else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.live) {
        window.webkit.messageHandlers.live.postMessage(msg);
      }
    }
    function select(index) {
      var loop = document.getElementById('doLoop').checked ? '1' : '0';
      var cut = document.getElementById('doCut').checked ? '1' : '0';
      post({method:"close_and_send", params:[index + ':' + loop + ':' + cut]});
    }
    function cancel() {
      post({method:"close_and_send", params:["__cancel__"]});
    }
  </script>
</body></html>`;
}

export function activate(activation: ActivationContext) {
  console.log("[SceneSend] activate() called");
  try {
    const context = initialize(activation, "1.0.0");
    const song = context.application.song;

    const CMD_SEND = "sceneSend.send";

    // Command must be registered before the context menu action that references
    // it — Windows validates command IDs at registration time.
    context.commands.registerCommand(CMD_SEND, (arg: unknown) =>
      void (async (handle: Handle) => {
        console.log("[SceneSend] >>> Send to Locator triggered <<<");
        try {
          const scene = context.getObjectFromHandle(handle, Scene);
          console.log(`[SceneSend] Scene: "${scene.name}"`);

          const sceneIndex = song.scenes.findIndex(
            (s) => s.handle.id === scene.handle.id,
          );
          if (sceneIndex < 0) {
            console.error("[SceneSend] Scene not found");
            return;
          }
          console.log(
            `[SceneSend] Scene index=${sceneIndex} of ${song.scenes.length}`,
          );

          const namedCues: CueEntry[] = song.cuePoints
            .filter((c) => c.name.trim().length > 0)
            .sort((a, b) => a.time - b.time)
            .map((c, i) => ({ index: i, name: c.name.trim(), time: c.time }));

          console.log(`[SceneSend] Found ${namedCues.length} named locators`);

          // Write modal HTML to temp file and load via file: URI.
          // data: URIs are blocked by WebView2 on Windows.
          const html = buildPickerModal(namedCues);
          const tempDir = context.environment.tempDirectory;
          let modalUrl: string;
          let tmpPath: string | null = null;
          if (tempDir !== undefined) {
            tmpPath = join(tempDir, "scene-send-modal.html");
            writeFileSync(tmpPath, html, "utf8");
            modalUrl = pathToFileURL(tmpPath).href;
          } else {
            modalUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
          }

          let raw: string | undefined;
          try {
            raw = await context.ui.showModalDialog(modalUrl, 320, 460);
          } finally {
            if (tmpPath !== null) {
              try { unlinkSync(tmpPath); } catch { /* ignore */ }
            }
          }

          console.log(`[SceneSend] Modal returned: "${raw}"`);
          if (!raw || raw === "__cancel__") {
            console.log("[SceneSend] Cancelled");
            return;
          }

          // Parse "{index}:{loop}:{cut}" e.g. "2:1:0"
          const parts = raw.split(":");
          const chosenIndex = parseInt(parts[0]!, 10);
          const loop = parts[1] === "1";
          const cut = parts[2] === "1";

          if (isNaN(chosenIndex) || chosenIndex < 0 || chosenIndex >= namedCues.length) {
            console.log(`[SceneSend] Invalid pick: ${raw}`);
            return;
          }

          const chosen = namedCues[chosenIndex]!;
          const next = namedCues[chosenIndex + 1];
          // maxDur is the beat distance to the next locator, used for cut/loop.
          // null when chosen is the last locator.
          const maxDur = next !== undefined ? next.time - chosen.time : null;

          console.log(
            `[SceneSend] Picked «${chosen.name}» @ ${chosen.time.toFixed(1)}` +
              (loop ? " +loop" : "") +
              (cut ? " +cut" : "") +
              (maxDur !== null ? ` maxDur=${maxDur.toFixed(1)}` : " (last locator)"),
          );

          const targetBeat = chosen.time;
          const beatsPerBar = Number(scene.signatureNumerator) * (4 / Number(scene.signatureDenominator));
          let copiedCount = 0;
          let skippedNoSlot = 0;
          let skippedEmpty = 0;
          let skippedTypeMismatch = 0;

          console.log(
            `[SceneSend] Walking ${song.tracks.length} tracks at scene ${sceneIndex}...`,
          );

          for (const track of song.tracks) {
            const trackName = track.name;
            try {
              const slot = track.clipSlots[sceneIndex];
              if (!slot) { skippedNoSlot++; continue; }
              const clip = slot.clip;
              if (!clip) { skippedEmpty++; continue; }

              const clipName = clip.name || "(unnamed)";

              if (clip instanceof MidiClip && track instanceof MidiTrack) {
                console.log(`[SceneSend]   MIDI "${trackName}" / "${clipName}" → copying...`);
                await copyMidiToArrangement(clip, track, targetBeat, maxDur, loop, cut, beatsPerBar);
                copiedCount++;
                console.log(`[SceneSend]   MIDI "${trackName}" / "${clipName}" ✓`);
              } else if (clip instanceof AudioClip && track instanceof AudioTrack) {
                console.log(`[SceneSend]   AUDIO "${trackName}" / "${clipName}" → copying...`);
                await copyAudioToArrangement(clip, track, targetBeat, maxDur, loop, cut, beatsPerBar);
                copiedCount++;
                console.log(`[SceneSend]   AUDIO "${trackName}" / "${clipName}" ✓`);
              } else {
                skippedTypeMismatch++;
              }
            } catch (err) {
              console.error(`[SceneSend]   ERROR on track "${trackName}":`, err);
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

    context.ui
      .registerContextMenuAction("Scene", "Send to Locator…", CMD_SEND)
      .then(() => console.log("[SceneSend] Menu registered"))
      .catch((err) => console.error("[SceneSend] Menu registration failed:", err));

    console.log("[SceneSend] Ready");
  } catch (err) {
    console.error("[SceneSend] activate() crashed:", err);
  }
}

// ── MIDI helpers ────────────────────────────────────────────

function loopMidiNotes(
  notes: NoteDescription[],
  clipDuration: number,
  maxDur: number,
  beatsPerBar: number,
): NoteDescription[] {
  const result: NoteDescription[] = [];
  let offset = 0;
  while (offset < maxDur) {
    for (const note of notes) {
      const newStart = note.startTime + offset;
      if (newStart >= maxDur) continue;
      result.push({
        ...note,
        startTime: newStart,
        duration: Math.min(note.duration, maxDur - newStart),
      });
    }
    offset = Math.ceil((offset + clipDuration) / beatsPerBar) * beatsPerBar;
  }
  return result;
}

// ── MIDI: copy clip to arrangement ─────────────────────────

async function copyMidiToArrangement(
  clip: MidiClip<"1.0.0">,
  track: MidiTrack<"1.0.0">,
  targetBeat: number,
  maxDur: number | null,
  loop: boolean,
  cut: boolean,
  beatsPerBar: number,
): Promise<void> {
  const notes = clip.notes;
  const name = clip.name;
  const color = clip.color;

  const maxEnd = notes.reduce((m, n) => Math.max(m, n.startTime + n.duration), 0);
  const clipDuration = clip.duration > 0 ? Math.max(clip.duration, maxEnd) : maxEnd || 4;

  let arrangementDur: number;
  let finalNotes: NoteDescription[];

  if (loop && maxDur !== null) {
    // Duplicate notes to fill maxDur — SDK provides no MIDI loopSettings.
    arrangementDur = maxDur;
    finalNotes = loopMidiNotes(notes, clipDuration, maxDur, beatsPerBar);
  } else if (cut && maxDur !== null && clipDuration > maxDur) {
    arrangementDur = maxDur;
    finalNotes = notes
      .filter((n) => n.startTime < maxDur)
      .map((n) => ({ ...n, duration: Math.min(n.duration, maxDur - n.startTime) }));
  } else {
    arrangementDur = clipDuration;
    finalNotes = notes;
  }

  console.log(
    `[SceneSend]     MIDI clipDur=${clipDuration.toFixed(1)} arrDur=${arrangementDur.toFixed(1)} notes=${finalNotes.length}`,
  );

  const newClip = await track.createMidiClip(targetBeat, arrangementDur);
  newClip.name = name;
  newClip.color = color;
  newClip.notes = finalNotes;
}

// ── Audio: copy clip to arrangement ────────────────────────

async function copyAudioToArrangement(
  clip: AudioClip<"1.0.0">,
  track: AudioTrack<"1.0.0">,
  targetBeat: number,
  maxDur: number | null,
  loop: boolean,
  cut: boolean,
  beatsPerBar: number,
): Promise<void> {
  const filePath = clip.filePath;
  const name = clip.name;
  const color = clip.color;
  const warping = clip.warping;
  const warpMode = clip.warpMode;

  // Step = smallest of loopSpan and markerSpan: loopEnd can extend past the
  // sample's natural end (endMarker), so taking the min prevents overestimating
  // how much audio content plays per cycle.
  const loopSpan = clip.loopEnd - clip.loopStart;
  const markerSpan = clip.endMarker - clip.startMarker;
  const minSpan = Math.min(
    loopSpan > 0 ? loopSpan : Infinity,
    markerSpan > 0 ? markerSpan : Infinity,
  );
  const stepDur = Number.isFinite(minSpan) ? minSpan : clip.duration > 0 ? clip.duration : 4;

  console.log(
    `[SceneSend]     AUDIO src: dur=${clip.duration} loopSpan=${loopSpan.toFixed(2)} markerSpan=${markerSpan.toFixed(2)} stepDur=${stepDur.toFixed(2)} warping=${warping}`,
  );

  if (loop && maxDur !== null) {
    // Place repeated copies to fill maxDur; each starts on a bar boundary,
    // last copy truncated at maxDur if needed.
    let pos = 0;
    let copies = 0;
    while (pos < maxDur) {
      const thisDur = Math.min(stepDur, maxDur - pos);
      const c = await track.createAudioClip({
        filePath,
        startTime: targetBeat + pos,
        duration: thisDur,
        isWarped: warping,
      });
      c.name = name;
      c.color = color;
      c.warpMode = warpMode;
      copies++;
      pos = Math.ceil((pos + stepDur) / beatsPerBar) * beatsPerBar;
    }
    console.log(`[SceneSend]     AUDIO looped ${copies} copies, stepDur=${stepDur.toFixed(2)} maxDur=${maxDur.toFixed(1)} beatsPerBar=${beatsPerBar}`);
  } else {
    const duration =
      cut && maxDur !== null && stepDur > maxDur ? maxDur : stepDur;
    const c = await track.createAudioClip({
      filePath,
      startTime: targetBeat,
      duration,
      isWarped: warping,
    });
    c.name = name;
    c.color = color;
    c.warpMode = warpMode;
    console.log(`[SceneSend]     AUDIO single: stepDur=${stepDur.toFixed(2)} placed=${duration.toFixed(2)}`);
  }
}
