// The first import of src/index.ts: the folder doctor's checks of the folders
// rafikicode needs (rafiki/folders.ts), run before any module that reads them
// is evaluated. See that file for what is checked and what each fix is.
//
// A compiled binary reads TMPDIR once, while it starts, and unpacks the
// interface's native library there (rafiki/exec-tmp.ts explains the
// measurement). So when the temporary folder had to be replaced, a compiled
// binary starts itself again with the fixed variables, once, and passes on the
// exit code. A run from source needs no restart: the variables set here are
// read by everything loaded after this module.
import { spawnSync } from "child_process"
import * as Folders from "./folders"

const AGAIN = "RAFIKICODE_FOLDERS_CHECKED"
const bunfs = ["/$bunfs/", "B:/~BUN/"]

function compiled() {
  const entry = process.argv[1] ?? ""
  return bunfs.some((prefix) => entry.startsWith(prefix))
}

function run() {
  if (process.env["RAFIKICODE_SKIP_FOLDER_CHECKS"] === "1") return
  // A restarted binary checks again, quietly: its parent already said it all.
  const again = process.env[AGAIN] === "1"
  const result = Folders.apply({ print: !again })
  if (again || !result.env["TMPDIR"] || !compiled()) return
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {})
  const child = spawnSync(process.execPath, process.argv.slice(2), {
    stdio: "inherit",
    env: { ...process.env, [AGAIN]: "1" },
  })
  if (child.error) return
  process.exit(child.status ?? 1)
}

try {
  run()
} catch {
  // The checks are a help, never a reason not to start.
}
