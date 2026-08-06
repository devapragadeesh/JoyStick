/**
 * Phase 0 verification, step 4: does the hook path cost measurable wall-clock?
 *
 * Runs the same scripted Claude Code task N times with the hooks live and N
 * times with them disabled, alternating, and reports the delta. Alternating
 * rather than batching keeps machine-level drift (thermal, background load)
 * from landing entirely on one arm.
 *
 * Two ways to turn the hooks off:
 *
 *   --mode uninstall  (default) actually uninstalls the plugin for the off arm
 *                     and reinstalls it for the on arm. This is the honest
 *                     comparison: it captures hook dispatch, process spawn, and
 *                     the sidecar round-trip together.
 *   --mode env        sets JOYSTICK_DISABLED=1, which makes the shim exit before
 *                     curl. Cheaper to run, but the sh spawn still happens in
 *                     both arms, so it measures only the round-trip.
 *
 * Note there is no environment variable that disables plugins — that was
 * checked, and CLAUDE_CODE_DISABLE_PLUGINS has no effect.
 *
 *   pnpm bench --repo /tmp/scratch --runs 3
 *   pnpm bench --repo /tmp/scratch --runs 3 --mode env
 */
import { spawn, execFileSync } from "node:child_process";

const args = process.argv.slice(2);

function opt(name: string, fallback: string): string {
  const i = args.indexOf(name);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
}

const repo = opt("--repo", process.cwd());
const runs = Number(opt("--runs", "3"));
const mode = opt("--mode", "uninstall");
const PLUGIN = "joystick@joystick-dev";

/** Install or uninstall the plugin, for the `uninstall` mode's arm switching. */
function setPluginInstalled(installed: boolean): void {
  try {
    execFileSync(
      "claude",
      installed
        ? ["plugin", "install", PLUGIN, "--scope", "user"]
        : ["plugin", "uninstall", PLUGIN, "--scope", "user", "--keep-data", "-y"],
      { stdio: "ignore" },
    );
  } catch {
    console.warn(`warning: could not ${installed ? "install" : "uninstall"} ${PLUGIN}`);
  }
}
const prompt = opt(
  "--prompt",
  "List the files in this directory, read package.json, and report the value of the name field. Do not modify anything.",
);

interface Timing {
  arm: string;
  ms: number;
  ok: boolean;
}

function runOnce(arm: "on" | "off"): Promise<Timing> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (mode === "env") {
      if (arm === "off") env.JOYSTICK_DISABLED = "1";
      else delete env.JOYSTICK_DISABLED;
    } else {
      delete env.JOYSTICK_DISABLED;
      setPluginInstalled(arm === "on");
    }

    const started = performance.now();
    const child = spawn("claude", ["-p", prompt, "--permission-mode", "bypassPermissions"], {
      cwd: repo,
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });

    child.on("close", (code) => {
      resolve({ arm, ms: performance.now() - started, ok: code === 0 });
    });
    child.on("error", () => resolve({ arm, ms: performance.now() - started, ok: false }));
  });
}

function stats(xs: number[]) {
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean, median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1)! };
}

async function main(): Promise<void> {
  console.log(`bench: ${runs} runs per arm, repo=${repo}, off-arm=${mode}`);
  const results: Timing[] = [];

  for (let i = 0; i < runs; i++) {
    // Alternate arms so drift is shared rather than concentrated.
    for (const arm of ["on", "off"] as const) {
      const t = await runOnce(arm);
      results.push(t);
      console.log(`  run ${i + 1} ${arm.padEnd(3)}: ${t.ms.toFixed(0)}ms${t.ok ? "" : "  (non-zero exit)"}`);
    }
  }

  const on = stats(results.filter((r) => r.arm === "on").map((r) => r.ms));
  const off = stats(results.filter((r) => r.arm === "off").map((r) => r.ms));
  const delta = ((on.mean - off.mean) / off.mean) * 100;
  // Median delta is the one to trust: a single slow model response skews the
  // mean by more than the entire hook path costs.
  const medianDelta = ((on.median - off.median) / off.median) * 100;
  const overlap = on.min <= off.max && off.min <= on.max;

  console.log("");
  console.log(`hooks on  → mean ${on.mean.toFixed(0)}ms  median ${on.median.toFixed(0)}ms  [${on.min.toFixed(0)}–${on.max.toFixed(0)}]`);
  console.log(`hooks off → mean ${off.mean.toFixed(0)}ms  median ${off.median.toFixed(0)}ms  [${off.min.toFixed(0)}–${off.max.toFixed(0)}]`);
  console.log(`delta (mean):   ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%`);
  console.log(`delta (median): ${medianDelta >= 0 ? "+" : ""}${medianDelta.toFixed(2)}%   (budget: ±2%)`);
  console.log(`ranges overlap: ${overlap ? "yes — arms are not separable" : "no"}`);
  console.log(
    Math.abs(medianDelta) <= 2
      ? "PASS"
      : "OVER BUDGET — but read this carefully before acting on it. An agent run is dominated by model latency, which varies far more between runs than the hook path could possibly cost. Check whether the two arms' [min–max] ranges overlap: if they do, this delta is variance, not signal. The hook-path microbenchmark in the README is the load-bearing measurement.",
  );

  if (mode === "uninstall") setPluginInstalled(true);
}

void main();
