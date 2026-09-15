// The PATH entry install/install.sh writes and its exact removal on uninstall.
import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as Shell from "../../src/rafiki/shell-path"

const installer = fs.readFileSync(path.resolve(import.meta.dir, "../../../../install/install.sh"), "utf8")
const dir = "/home/jane/.rafikicode/bin"

describe("installer PATH entry", () => {
  test("the lines match what install.sh writes", () => {
    expect(installer).toContain('echo -e "\\n# ${APP}" >> "$config_file"')
    expect(installer).toContain('command="export PATH=$INSTALL_DIR:\\$PATH"')
    expect(installer).toContain('command="fish_add_path $INSTALL_DIR"')
    expect(Shell.marker()).toBe("# rafikicode")
    expect(Shell.commands(dir)).toEqual([`export PATH=${dir}:$PATH`, `fish_add_path ${dir}`])
  })

  test("only the installer's lines are removed, and the file is otherwise unchanged", () => {
    const before = "alias ll='ls -l'\nexport PATH=/opt/other/bin:$PATH\n"
    expect(Shell.clean(before + `\n# rafikicode\nexport PATH=${dir}:$PATH\n`, dir)).toEqual({ content: before, changed: true })
    // Another directory, or a line edited by hand, stays.
    const other = `export PATH=/opt/rafikicode/bin:$PATH\n# rafikicode\nexport PATH="${dir}:$PATH"\n`
    expect(Shell.clean(other, dir)).toEqual({ content: other, changed: false })
    expect(Shell.clean(`fish_add_path ${dir}\n`, dir)).toEqual({ content: "", changed: true })
  })

  test("finds and cleans every startup file holding the entry, and nothing else", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-shell-"))
    try {
      fs.writeFileSync(path.join(home, ".bashrc"), `# mine\n\n# rafikicode\nexport PATH=${dir}:$PATH\n`)
      fs.writeFileSync(path.join(home, ".profile"), "# untouched\n")
      fs.mkdirSync(path.join(home, ".config", "fish"), { recursive: true })
      fs.writeFileSync(path.join(home, ".config", "fish", "config.fish"), `set x 1\n\n# rafikicode\nfish_add_path ${dir}\n`)
      const found = await Shell.configsWithPath(dir, {}, home)
      expect(found.sort()).toEqual([path.join(home, ".bashrc"), path.join(home, ".config", "fish", "config.fish")].sort())
      for (const file of found) expect(await Shell.cleanFile(file, dir)).toBe(true)
      expect(fs.readFileSync(path.join(home, ".bashrc"), "utf8")).toBe("# mine\n")
      expect(fs.readFileSync(path.join(home, ".config", "fish", "config.fish"), "utf8")).toBe("set x 1\n")
      expect(fs.readFileSync(path.join(home, ".profile"), "utf8")).toBe("# untouched\n")
      expect(await Shell.configsWithPath(dir, {}, home)).toEqual([])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
