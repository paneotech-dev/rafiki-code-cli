// Runs the CLI from source in a throwaway home, for the tests that need a
// real process (the wire to the mock gateway, the output of a command). Every
// directory the CLI writes to is under the given home; the environment's own
// key and CI markers are removed.
import path from "path"

const root = path.resolve(import.meta.dir, "../..")

export async function spawnCli(home: string, args: string[], extra: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    COLUMNS: "120",
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    RAFIKICODE_TEST_TTY: "1",
  }
  delete env["XDG_CONFIG_HOME"]
  delete env["CI"]
  delete env["GITHUB_ACTIONS"]
  delete env["RAFIKICODE_API_KEY"]
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args], {
    cwd: home,
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr, all: stdout + stderr }
}
