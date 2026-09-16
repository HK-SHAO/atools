import { cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { strings } from "../app/lib/i18n.ts";
import { open, serve, sleep, waitFor } from "./cdp.ts";

const PORT = Number(process.env.UI_PORT ?? 4399);
const project = `${import.meta.dirname}/..`;
const SUBPATH = process.env.SUBPATH ?? "";
const BASELINE = process.env.UI_BASELINE ?? "";

// The gate drives the English UI (headless Chrome defaults to en-US). Labels come from the
// dictionary rather than being retyped, so a copy change cannot silently desync the gate.
const L = strings("en");
const VERIFY_PCT = new RegExp(`^${L.verifying.replace("{pct}", String.raw`(\d+)`)}$`);

type Ev = <R = unknown>(expression: string) => Promise<R>;

const INSTRUMENT = `
  window.__ac = 0;
  for (const name of ["AudioContext", "webkitAudioContext"]) {
    const Native = window[name];
    if (!Native) continue;
    window[name] = class extends Native {
      constructor(...args) {
        super(...args);
        window.__ac += 1;
      }
    };
  }
  const live = new Set();
  window.__synth = { posted: 0, inflight: 0 };
  window.__jobs = { posted: {}, cancelled: {}, aborted: {}, done: {}, encodes: 0 };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      const post = this.postMessage.bind(this);
      this.postMessage = (message, ...rest) => {
        if (message && message.kind === "synthesise") {
          window.__synth.posted += 1;
          window.__synth.inflight += 1;
          live.add(message.id);
        }
        if (message && message.kind === "audit") window.__jobs.posted[message.id] = 1;
        if (message && message.kind === "encode") window.__jobs.encodes += 1;
        if (message && message.kind === "cancel" && Array.isArray(message.ids))
          for (const id of message.ids) window.__jobs.cancelled[id] = 1;
        post(message, ...rest);
      };
      this.addEventListener("message", (event) => {
        const data = event.data;
        if (data && live.has(data.id) && data.kind !== "progress") {
          live.delete(data.id);
          window.__synth.inflight -= 1;
        }
        if (data && window.__jobs.posted[data.id]) {
          if (data.kind === "aborted") window.__jobs.aborted[data.id] = 1;
          if (data.kind === "done") window.__jobs.done[data.id] = 1;
        }
      });
    }
  };
`;

const PLAY = `(() => {
   const b = document.querySelector('button.icon-btn');
   if (!b) throw new Error("no play button on the page");
   b.click();
   return 1;
 })()`;

const PLAYING = `
  return document.querySelector('button.icon-btn')?.getAttribute('aria-label') === ${JSON.stringify(L.pause)} ? 1 : 0`;


const press = (sel: string, label: string): string =>
  `(() => {
     const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(v => (v.textContent ?? '').trim() === ${JSON.stringify(label)});
     if (!b) throw new Error(${JSON.stringify("no such button on the page: ")} + ${JSON.stringify(label)});
     if (b.disabled) throw new Error(${JSON.stringify("button is not clickable right now: ")} + ${JSON.stringify(label)});
     b.click();
     return 1;
   })()`;

const FACTS = "return document.querySelector('p.facts')?.textContent ?? ''";

const enabled = (label: string): string =>
  `return (() => {
     const b = [...document.querySelectorAll('button.act')].find(v => (v.textContent ?? '').trim() === ${JSON.stringify(label)});
     return b && !b.disabled ? 1 : 0;
   })()`;

const pngOf = (line: string): string => line.match(/PNG [^;]+/)?.[0] ?? "";

async function chain(
  ev: Ev,
  mark: (label: string) => void,
  onReady?: () => Promise<void>,
  probe = false,
  chrome = false,
): Promise<readonly [string, string]> {
  await waitFor("app loaded", async () =>
    (await ev<number>("return document.querySelector('.drop') ? 1 : 0")) ? 1 : null,
  );
  await onReady?.();

  await ev(press("button.act", L.demo));
  await waitFor(
    "demo ready (decode + encode + image)",
    async () => ((await ev<number>("return document.querySelector('.spec') ? 1 : 0")) ? 1 : null),
    120000,
  );
  mark("demo ready");

  const contexts = await ev<number>("return window.__ac ?? -1");
  if (contexts === 0)
    failures.push(
      "no AudioContext had been constructed when the demo was ready: that one-off hundred-odd\n      milliseconds lands on the first play click",
    );
  if (contexts > 0) mark(`${contexts} AudioContexts before playback`);

  if (chrome) await chromeChecks(ev, mark);

  // The parameters live inside the Advanced card, so open it first; chips pressed later then hit
  // the real UI. chromeChecks above pins down its existence in the main build, so tolerating
  // failure here cannot hide the problem.
  await ev(`
    const d = document.querySelector('details.more');
    if (d && !d.open) d.querySelector('summary')?.click();
    return 1;
  `);

  if (probe) {
    const posted = await waitFor(
      "background bake started",
      async () => {
        const s = await ev<{ posted: number; inflight: number }>("return window.__synth");
        return s.posted >= 1 ? s.posted : null;
      },
      10000,
    ).catch(() => 0);
    const baked = posted
      ? await waitFor(
          "background bake finished",
          async () => {
            const s = await ev<{ posted: number; inflight: number }>("return window.__synth");
            return s.inflight === 0 ? s : null;
          },
          120000,
        ).catch(() => null)
      : null;
    if (!baked)
      failures.push(
        "the worker had not finished restoring when the demo was ready: clicking play still computes it\n        on the spot, and that wait lands on the user",
      );
    else {
      const ms = await ev<number>(`
        return await new Promise((done) => {
          const b = document.querySelector('button.icon-btn');
          const t0 = performance.now();
          const mo = new MutationObserver(() => {
            if (b.getAttribute('aria-label') === ${JSON.stringify(L.pause)}) {
              mo.disconnect();
              done(Math.round(performance.now() - t0));
            }
          });
          mo.observe(b, { attributes: true, attributeFilter: ['aria-label'] });
          b.click();
          setTimeout(() => { mo.disconnect(); done(-1); }, 60000);
        });
      `);
      await ev(PLAY);
      await waitFor("stopped", async () => ((await ev<number>(PLAYING)) ? null : 1));
      const after = await ev<{ posted: number; inflight: number }>("return window.__synth");
      mark(`click to sound ${ms} ms (baked ${baked.posted}× while the material loaded)`);
      if (ms < 0) failures.push("play was clicked but no sound ever came out");
      else if (after.posted !== baked.posted)
        failures.push(
          `clicking play made the worker recompute the restore (${baked.posted} → ${after.posted}): it was not\n          baked while the material was loading`,
        );
    }
  }

  await ev(`
    window.__auditBtn = [];
    const mo = new MutationObserver(() => {
      const b = [...document.querySelectorAll('button.act')].find(v => v.textContent.startsWith(${JSON.stringify(L.verify)}));
      if (b) window.__auditBtn.push(b.textContent.trim());
    });
    mo.observe(document.querySelector('.acts'), { subtree: true, childList: true, characterData: true });
  `);
  await ev(press("button.act", L.verify));
  const compact = await waitFor(
    "compact verify",
    async () => {
      const t = await ev<string>(FACTS);
      return t.includes(L.lossLsd) ? t : null;
    },
    60000,
  );
  mark(`compact verify  ${compact}`);

  const pcts = [
    ...new Set(
      ((await ev<string[]>("return window.__auditBtn")) ?? [])
        .map(t => VERIFY_PCT.exec(t)?.[1])
        .filter(Boolean),
    ),
  ];
  if (!pcts.length)
    failures.push(`the button never showed a "${L.verifying.replace("{pct}", "N")}" progress: worker progress is not\n      wired to the UI`);
  else if (pcts.length < 2)
    failures.push(`verify progress showed a single step (${pcts.join(",")}): no visible advance`);

  await ev(press("button.act", L.rebuildPhase));
  await waitFor(
    "fine render done",
    async () => ((await ev<string>(FACTS)).includes(L.hintRefined) ? true : null),
    120000,
  );
  mark("phase rebuilt");

  await ev(press("button.chip", L.exact));
  const rendered = await waitFor(
    "exact image",
    async () => {
      const t = await ev<string>(FACTS);
      if (!t.includes(L.storeExact) || pngOf(t) === "" || pngOf(t) === pngOf(compact)) return null;
      return (await ev<number>(enabled(L.verify))) ? t : null;
    },
    120000,
  );
  mark("exact image");

  await ev(press("button.act", L.verify));
  const exact = await waitFor(
    "exact verify",
    async () => {
      const t = await ev<string>(FACTS);
      return (t.includes(L.lossAll) || t.includes(L.selfCheck)) && t !== rendered ? t : null;
    },
    60000,
  );
  mark(`exact verify  ${exact}`);

  await ev(`
    const audit = [...document.querySelectorAll('button.act')].find(v => v.textContent.trim() === ${JSON.stringify(L.verify)});
    const chip = [...document.querySelectorAll('button.chip')].find(v => v.textContent.trim() === ${JSON.stringify(L.compact)});
    if (!audit || audit.disabled) throw new Error("the Verify button is unavailable");
    if (!chip || chip.disabled) throw new Error("the Compact chip is unavailable");
    audit.click();
    chip.click();
    return 1;
  `);
  const jobs = await waitFor(
    "verify withdrawn after a parameter change",
    async () => {
      const j = await ev<{
        posted: Record<string, number>;
        cancelled: Record<string, number>;
        aborted: Record<string, number>;
        encodes: number;
      }>("return window.__jobs");
      return Object.keys(j.posted).length >= 3 &&
        Object.keys(j.cancelled).length >= 1 &&
        Object.keys(j.aborted).length >= 1 &&
        j.encodes >= 1
        ? j
        : null;
    },
    60000,
  ).catch(() => null);
  if (!jobs)
    failures.push(
      "a parameter changed mid-verify: the running verify was not cancelled and burned to the end\n      (blocking the worker, so the new encode just queues behind it)",
    );
  else mark(`verify withdrawn on parameter change (${Object.keys(jobs.cancelled).length} jobs cancelled)`);

  // Image round trip: read the saved exact PNG back and the phase hint and the Rebuild phase
  // button must agree. (Regression guard: the hint once said "rebuildable" while the button was
  // gone, because loading re-encoded the spectrum and left the hint from the old image.)
  await ev(press("button.chip", L.exact));
  await waitFor(
    "exact image (for the round trip)",
    async () => {
      const t = await ev<string>(FACTS);
      return t.includes(L.storeExact) && (await ev<number>(enabled(L.verify))) ? t : null;
    },
    120000,
  );

  await ev(`
    window.__capBlob = null;
    window.__capName = null;
    const origURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob) window.__capBlob = b; return origURL(b); };
    const proto = HTMLElement.prototype;
    const origClick = proto.click;
    proto.click = function () {
      if (this.tagName === 'A' && this.download) { window.__capName = this.download; return 1; }
      return origClick.call(this);
    };
    return 1;
  `);
  await ev(press("button.act", L.saveImage));
  const roundtrip = await ev<{ size: number; label: string; encodes: number; name: string }>(`
    if (!window.__capBlob || !window.__capName) throw new Error("Save image produced no interceptable PNG");
    const kb = n => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
    const drop = async (blob, name) => {
      const dt = new DataTransfer();
      dt.items.add(new File([blob], name, { type: name.endsWith(".jpg") ? "image/jpeg" : "image/png" }));
      const target = document.querySelector('.app');
      if (!target) throw new Error("no drop target on the page");
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    };
    window.__dropPng = () => drop(window.__capBlob, window.__capName);
    window.__dropJpeg = async q => {
      const bmp = await createImageBitmap(window.__capBlob);
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * 0.7);
      c.height = Math.round(bmp.height * 0.7);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const jpeg = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
      await drop(jpeg, window.__capName.replace(/\\.png$/i, '.jpg'));
      return jpeg.size;
    };
    return { size: window.__capBlob.size, label: "PNG " + kb(window.__capBlob.size), encodes: window.__jobs.encodes, name: window.__capName };
  `);
  mark(`captured ${roundtrip.name} (${roundtrip.size} bytes)`);

  await ev("return window.__dropPng()");
  await waitFor(
    "lossless PNG read back",
    async () => ((await ev<string>(FACTS)).includes(L.readExact) ? true : null),
    60000,
  );
  const pngLine = await ev<string>(FACTS);
  if (!pngLine.includes(roundtrip.label))
    failures.push(
      `the size shown after reading the lossless PNG back does not match the file (${pngLine.match(/PNG [^;]+/)?.[0]}, expected ${roundtrip.label}): the job should use the file read back`,
    );
  if (await ev<number>(enabled(L.rebuildPhase)))
    failures.push(
      "lossless exact PNG read back: a Rebuild phase button appeared (the phase is complete, there is nothing to rebuild)",
    );
  if ((await ev<string>(FACTS)).includes(L.rebuildPhase))
    failures.push("lossless exact PNG read back: a phase-rebuild hint appeared");
  if ((await ev<number>("return window.__jobs.encodes")) !== roundtrip.encodes)
    failures.push(
      `reading the lossless PNG back re-encoded it (${roundtrip.encodes}→): the spectrum read back should be the job itself, and the phase reference must not be thrown away`,
    );

  await ev("return window.__dropJpeg(0.08)");
  const damaged = await waitFor(
    "damaged JPEG read back",
    async () => {
      const t = await ev<string>(FACTS);
      if (t.includes(L.rebuildPhase)) return { line: t, err: "" };
      const err = await ev<string>(
        "return document.querySelector('.note.is-error')?.textContent ?? ''",
      );
      return err ? { line: t, err } : null;
    },
    60000,
  ).catch(() => null);
  if (!damaged || damaged.err) {
    const factsNow = await ev<string>(FACTS);
    failures.push(
      `reading the damaged JPEG back never finished: ${damaged?.err || "timed out; the phase reference was neither called weak nor reported as an error (the damage may have gone unnoticed)"}; facts now: ${factsNow}`,
    );
  } else {
    const weakBtn = await ev<number>(enabled(L.rebuildPhase));
    if (!weakBtn)
      failures.push(`damaged image read back: a rebuild hint but no Rebuild phase button, ${damaged.line}`);
    else mark("damaged image read back: hint and button agree, the phase reference is usable");
  }

  return [compact, exact];
}

interface MoreState {
  open: boolean;
  height: number;
  slack: number;
  shown: boolean;
}

const MORE_PROBE = `
  const details = document.querySelector('details.more');
  const chip = [...document.querySelectorAll('button.chip')].find(v => v.textContent.trim() === ${JSON.stringify(L.exact)});
  if (!details || !chip) return null;
  const head = details.querySelector('summary').getBoundingClientRect();
  const cs = getComputedStyle(details);
  const frame = head.height
    + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  return {
    open: details.open,
    height: Math.round(details.getBoundingClientRect().height),
    slack: Math.round(details.getBoundingClientRect().height - frame),
    shown: chip.checkVisibility(),
  };
`;

interface Narrow {
  cw: number;
  over: number;
  clipped: string[];
  shell: number;
  spec: number;
  acts: number;
}

// .app is overflow-x: hidden, so horizontal overflow never reaches the document (documentElement's
// scrollWidth always equals clientWidth); it is silently clipped instead. Measure element by
// element rather than trusting the document width.
const SCAN_NARROW = `
  const scan = () => {
    const w = (s) => Math.round(document.querySelector(s)?.getBoundingClientRect().width ?? 0);
    const app = document.querySelector('.app');
    const clipped = [];
    for (const el of app.querySelectorAll('*'))
      if (el.scrollWidth > el.clientWidth + 1)
        clipped.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] +
          ' ' + el.clientWidth + '→' + el.scrollWidth);
    return {
      cw: document.documentElement.clientWidth,
      over: app.scrollWidth - app.clientWidth,
      clipped: clipped.slice(0, 5),
      shell: w('.shell'),
      spec: w('.spec'),
      acts: w('.acts'),
    };
  };
`;

// Only runs for the main build: the baseline is an older dist without the Advanced and About UI.
async function chromeChecks(ev: Ev, mark: (label: string) => void): Promise<void> {
  // A closed dialog must occupy nothing: the moment the author's .about beats the UA's
  // `dialog:not([open]) { display: none }`, it overlays the page at absolute + margin: auto.
  const idle = await ev<{ display: string; shown: boolean } | null>(`
    const d = document.querySelector('dialog.about');
    if (!d) throw new Error("no About dialog on the page");
    return { display: getComputedStyle(d).display, shown: d.checkVisibility() };
  `);
  if (!idle) failures.push("no About dialog on the page");
  else if (idle.shown || idle.display !== "none")
    failures.push(`the closed About dialog still takes up the page (display: ${idle.display}): a style beat dialog:not([open])`);
  else mark("closed About dialog occupies nothing");

  const shut = await ev<MoreState | null>(MORE_PROBE);
  if (!shut) failures.push("no Advanced card or parameter control on the page");
  else if (shut.open || shut.shown)
    failures.push("the Advanced card is visible on arrival: the default view should not carry those parameters");
  // Collapsed, the card must be exactly its summary row plus its own border and padding: once
  // details is laid out as a flex container the hidden body still eats a gap (8px measured), and
  // the "grows when expanded, parameters visible" checks cannot see that.
  else if (Math.abs(shut.slack) > 1)
    failures.push(`collapsed Advanced still leaves ${shut.slack}px for the hidden parameters: the card must not be laid out as a flex container`);
  else mark(`Advanced collapsed by default (card ${shut.height}px)`);

  // checkVisibility rather than getBoundingClientRect: inside a collapsed details the latter still
  // returns the old box.
  await ev(`document.querySelector('details.more > summary').click(); return 1`);
  const expanded = await ev<MoreState | null>(MORE_PROBE);
  if (!expanded || !expanded.open || !expanded.shown)
    failures.push("parameters are still invisible after opening Advanced: the toggle is broken");
  else if (expanded.height <= (shut?.height ?? 0))
    failures.push(`the card did not grow after expanding Advanced (${shut?.height} → ${expanded.height}): the parameters never came out`);
  else mark(`Advanced expanded to ${expanded.height}px, parameters visible`);

  await ev(`
    const b = document.querySelector('button.head-btn');
    if (!b) throw new Error("no About button in the header");
    b.click();
    return 1;
  `);
  const about = await ev<{
    open: boolean;
    box: [number, number];
    inView: boolean;
    title: boolean;
    close: boolean;
  }>(`
    const d = document.querySelector('dialog.about');
    if (!d) throw new Error("no About dialog on the page");
    const r = d.getBoundingClientRect();
    const head = document.querySelector('#about-title').getBoundingClientRect();
    const foot = document.querySelector('.about-foot button').getBoundingClientRect();
    const inside = (b) => b.height > 0 && b.top >= -1 && b.bottom <= window.innerHeight + 1;
    return {
      open: d.open,
      box: [Math.round(r.width), Math.round(r.height)],
      inView: r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1,
      title: inside(head),
      close: inside(foot),
    };
  `);
  if (!about.open) failures.push("clicking About did not open the dialog");
  else if (!about.inView)
    failures.push(`the About dialog does not fit in the viewport (${about.box.join("×")})`);
  else if (!about.title || !about.close)
    failures.push("the About title or the Close button is outside the viewport: the body pushed them off screen");
  else mark(`About dialog ${about.box.join("×")}, title and Close both in view`);

  await ev(`document.querySelector('.about-foot button').click(); return 1`);
  if (await ev<boolean>(`return document.querySelector('dialog.about').open`))
    failures.push("clicking Close inside the dialog did not close it");
  else mark("About dialog closes");
}

const staged = SUBPATH ? `${tmpdir()}/atools-subpath-${process.pid}` : "";
if (staged) await cp(`${project}/dist`, `${staged}${SUBPATH}`, { recursive: true });
const base = `http://127.0.0.1:${PORT}${SUBPATH}/`;
const server = serve(PORT, { dir: staged || `${project}/dist` });
const session = await open({ port: PORT + 1000, size: [1200, 900], url: "about:blank" });
const ev = session.ev;
await session.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });

const failures: string[] = [];
const errs: string[] = [];
session.on(m => {
  if (m.method === "Runtime.exceptionThrown")
    errs.push(m.params?.exceptionDetails?.exception?.description ?? "(uncaught exception)");
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error")
    errs.push(
      "console.error " +
        (m.params.args ?? []).map((a: any) => a.description ?? JSON.stringify(a.value) ?? "").join(" "),
    );
});

await session.goto(`${base}${staged ? "index.html" : ""}`, ".drop");

let origin = 0;
const mark = (label: string, at = performance.now()) =>
  console.log(`  ${String(Math.round(at - origin)).padStart(6)}ms  ${label}`);

let compact = "";
let exact = "";
try {
  [compact, exact] = await chain(
    ev,
    mark,
    async () => {
      origin = await ev<number>("return Math.round(performance.now())");
      await ev(`
        window.__ui = { tasks: [], notes: [] };
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) window.__ui.tasks.push([Math.round(e.startTime), Math.round(e.duration)]);
        }).observe({ entryTypes: ['longtask'] });
        let last = '';
        setInterval(() => {
          const notes = document.querySelectorAll('p.note');
          const text = notes.length ? notes[notes.length - 1].textContent.replace(/\\d+%$/, '') : '';
          if (text !== last) { last = text; window.__ui.notes.push([Math.round(performance.now()), text]); }
        }, 20);
        return true;
      `);
      console.log("ui chain:");
    },
    true,
    true,
  );

  const pairs = [
    [L.compact, compact],
    [L.exact, exact],
  ] as const;
  for (const [mode, line] of pairs) {
    if (line.includes(L.lossLsd) || line.includes(L.lossAll)) {
      for (const label of [L.case, L.caseLossy, L.caseHalf])
        if (!line.includes(`${label} `))
          failures.push(`${mode} verify is missing the "${label}" row: ${line}`);
    } else if (!line.includes(L.selfCheck))
      failures.push(`${mode} verify gave no verdict: ${line}`);
  }

  const seen = await ev<{ tasks: [number, number][]; notes: [number, string][] }>("return window.__ui");
  console.log("  stages (reconstructed from p.note text changes):");
  for (const [at, text] of seen.notes) mark(text || "(silent)", at);
  const total = seen.tasks.reduce((sum, [, ms]) => sum + ms, 0);
  console.log(`  long tasks on the main thread (>50 ms): ${seen.tasks.length}, ${total} ms total`);
  for (const [at, ms] of seen.tasks) mark(`blocked ${ms} ms`, at);

  // Narrow screens: the UI is designed for phones, so nothing may overflow horizontally at 320 wide.
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 320,
    height: 640,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(400);
  const narrow = await ev<Narrow>(`${SCAN_NARROW}\nreturn scan();`);
  // Positive control: stretch the spectrogram to 900px and the same scan must report both the
  // overflow and where it came from. Without it, a wrong selector or a degraded scan would answer
  // "all clear" to anything and still pass.
  const forced = await ev<Narrow>(`${SCAN_NARROW}
    const st = document.createElement('style');
    st.textContent = '.spec { min-width: 900px; }';
    document.head.append(st);
    const out = scan();
    st.remove();
    return out;
  `);
  // cw is a second positive control for this assertion: if the viewport never changed, the overflow
  // check would be reporting "fine" about a wide screen.
  if (narrow.cw !== 320)
    failures.push(`the narrow step never switched to 320 wide (got ${narrow.cw}): the check itself did not take effect`);
  else if (!(forced.over > 0 && forced.clipped.length))
    failures.push(
      `the overflow scan is broken: stretching the spectrogram to 900px still reports nothing\n      (shell over by ${forced.over}px, ${forced.clipped.length} element-level readings)`,
    );
  else if (narrow.over > 0 || narrow.clipped.length)
    failures.push(
      `content overflows horizontally at 320 wide and gets clipped: shell over by ${narrow.over}px;\n      ${narrow.clipped.join(", ") || "(no element-level readings)"}`,
    );
  else mark(`no horizontal clipping at 320 wide (shell ${narrow.shell}, spectrogram ${narrow.spec}, actions ${narrow.acts})`);
  await session.send("Emulation.clearDeviceMetricsOverride", {});
} catch (e) {
  failures.push(String(e));
  console.log("  facts now:", await ev<string>(FACTS).catch(() => "(unavailable)"));
} finally {
  await session.stop();
  server.stop();
  if (staged) await rm(staged, { recursive: true, force: true });
}

if (BASELINE && compact && exact) {
  console.log(`\nbaseline comparison (${BASELINE}):`);
  const port = PORT + 2;
  const theirServer = serve(port, { dir: BASELINE });
  const theirSession = await open({
    port: port + 1000,
    size: [1200, 900],
    url: `http://127.0.0.1:${port}/`,
  });
  let theirs: readonly [string, string] = ["", ""];
  try {
    theirs = await chain(theirSession.ev, () => {});
  } catch (e) {
    failures.push(`the baseline run did not complete: ${String(e)}`);
  } finally {
    await theirSession.stop();
    theirServer.stop();
  }
  const compared = [
    [L.compact, compact, theirs[0]],
    [L.exact, exact, theirs[1]],
  ] as const;
  for (const [mode, mine, their] of compared) {
    const same = mine === their;
    console.log(`  ${mode}: ${same ? "identical to the baseline, character for character" : "*** differs from the baseline ***"}`);
    if (!same)
      failures.push(`baseline mismatch (${mode}):\n      candidate ${mine}\n      baseline ${their}`);
  }
}

if (errs.length) failures.push(...errs.slice(0, 5));
if (failures.length) {
  console.error(`\nfailed checks: ${failures.length}`);
  for (const why of failures) console.error(`  - ${why}`);
  process.exit(1);
}
console.log(
  `\nui chain passed: demo / verify (compact and exact) / rebuild phase all in place, no page exceptions` +
    (BASELINE ? ", both lines identical to the baseline character for character" : ""),
);
process.exit(0);
