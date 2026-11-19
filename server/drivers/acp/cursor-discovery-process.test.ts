import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { probeCursorAuth } from "./cursor.ts";
import { discoverAcpModels } from "./custom-model-catalog.ts";

async function fixture(pipes: "ignore" | "inherit" = "ignore") {
  const dir = await mkdtemp(join(tmpdir(), "omb-cursor-discovery-process-"));
  const script = join(dir, "cursor.mjs");
  const pidFile = join(dir, "pid");
  await writeFile(script, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv[2] === "descendant") {
  process.on("SIGTERM", () => {});
  writeFileSync(process.env.PROBE_PID, String(process.pid));
  process.send("ready");
  setInterval(() => {}, 1000);
} else if (process.argv.length === 3 && process.argv[2] === "status") {
  console.log(JSON.stringify({ isAuthenticated: true }));
} else {
  const child = spawn(process.execPath, [import.meta.filename, "descendant"], {
    env: process.env, stdio: ["ignore", process.env.PROBE_PIPES, process.env.PROBE_PIPES, "ipc"],
  });
  await new Promise(resolve => child.once("message", resolve));
  process.on("SIGTERM", () => process.exit(0));
  if (process.argv[2] === "acp") {
    createInterface({ input: process.stdin }).on("line", line => {
      const msg = JSON.parse(line);
      const result = msg.method === "initialize" ? { protocolVersion: 1 } : {
        sessionId: "discovery", models: {
          currentModelId: "auto", availableModels: [{ modelId: "auto", name: "Auto" }],
        },
      };
      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  }
  setInterval(() => {}, 1000);
}
`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir, PROBE_PID: pidFile, PROBE_PIPES: pipes };
  delete env.CURSOR_API_KEY;
  delete env.CURSOR_AUTH_TOKEN;
  return {
    cli: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, env,
    pid: async () => Number(await readFile(pidFile, "utf8")),
    async cleanup() {
      try { process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL"); } catch {}
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function running(pid: number): boolean {
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return !!state && !state.startsWith("Z");
  } catch { return false; }
}

it.skipIf(process.platform === "win32").each(["ignore", "inherit"] as const)("reaps a TERM-resistant status descendant after the wrapper times out (%s pipes)", async (pipes) => {
  const probe = await fixture(pipes);
  try {
    expect(await probeCursorAuth(probe.cli, probe.env)).toBe(true);
    const pid = await probe.pid();
    await expect.poll(() => running(pid), { timeout: 1500 }).toBe(false);
  } finally { await probe.cleanup(); }
}, 20_000);

it.skipIf(process.platform === "win32")("reaps a TERM-resistant ACP discovery descendant after its wrapper exits", async () => {
  const probe = await fixture();
  try {
    const catalog = await discoverAcpModels(probe.env, probe.cli, ["acp"], { variants: false });
    expect(catalog.options).toContainEqual({ id: "auto", label: "Auto" });
    const pid = await probe.pid();
    await expect.poll(() => running(pid), { timeout: 1500 }).toBe(false);
  } finally { await probe.cleanup(); }
}, 10_000);
