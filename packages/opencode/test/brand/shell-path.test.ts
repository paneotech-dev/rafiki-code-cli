// The PATH entry install/install.sh writes, the symlink it drops into a
// directory already on PATH, and the exact removal of both on uninstall.
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

describe("installer symlink on PATH", () => {
  // install.sh (link_into_path) links from the first of these that is on PATH
  // and writable; uninstall has to look in the same two places.
  //
  // The installer reads the home directory through HOME_DIR rather than HOME,
  // because an unset HOME killed it outright under set -u. The pinned string
  // follows it: the point of this assertion is that the two sides agree on
  // which directories are tried, not which variable spells the home.
  test("the directories match what install.sh links from", () => {
    expect(installer).toContain('for dir in /usr/local/bin "$HOME_DIR/.local/bin"; do')
    expect(installer).toContain('link="${dir}/${BIN_NAME}"')
    expect(Shell.linkDirs("/home/jane")).toEqual(["/usr/local/bin", "/home/jane/.local/bin"])
    expect(Shell.linkCandidates(`${dir}/rafikicode`, "/home/jane")).toEqual([
      "/usr/local/bin/rafikicode",
      "/home/jane/.local/bin/rafikicode",
    ])
  })

  // A throwaway home, so only files this test made are ever looked at.
  const withHome = async (fn: (home: string, binary: string, link: string) => Promise<void>) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-link-"))
    const binary = path.join(home, ".rafikicode", "bin", "rafikicode")
    const link = path.join(home, ".local", "bin", "rafikicode")
    fs.mkdirSync(path.dirname(binary), { recursive: true })
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.writeFileSync(binary, "#!/bin/sh\n")
    try {
      await fn(home, binary, link)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }

  test("our own link is found and removed, even once the binary is gone", async () => {
    await withHome(async (home, binary, link) => {
      fs.symlinkSync(binary, link)
      expect(await Shell.ownedLinks(binary, home)).toEqual([link])
      // Uninstall removes the install directory first: the link is dangling by
      // the time it is removed, which is exactly the state that has to go.
      fs.rmSync(path.dirname(binary), { recursive: true, force: true })
      expect(await Shell.ownsLink(link, binary)).toBe(true)
      expect(await Shell.removeLink(link, binary)).toBe(true)
      expect(fs.existsSync(link)).toBe(false)
      expect(fs.lstatSync(path.dirname(link)).isDirectory()).toBe(true)
      // Nothing left to do the second time.
      expect(await Shell.removeLink(link, binary)).toBe(false)
    })
  })

  test("a regular file at that name is someone else's and is left alone", async () => {
    await withHome(async (home, binary, link) => {
      fs.writeFileSync(link, "not ours\n")
      expect(await Shell.ownedLinks(binary, home)).toEqual([])
      expect(await Shell.ownsLink(link, binary)).toBe(false)
      expect(await Shell.removeLink(link, binary)).toBe(false)
      expect(fs.readFileSync(link, "utf8")).toBe("not ours\n")
    })
  })

  test("a symlink pointing somewhere else is left alone", async () => {
    await withHome(async (home, binary, link) => {
      const other = path.join(home, "other", "rafikicode")
      fs.mkdirSync(path.dirname(other), { recursive: true })
      fs.writeFileSync(other, "#!/bin/sh\n")
      fs.symlinkSync(other, link)
      expect(await Shell.ownedLinks(binary, home)).toEqual([])
      expect(await Shell.removeLink(link, binary)).toBe(false)
      expect(fs.readlinkSync(link)).toBe(other)
    })
  })

  test("a relative link target is resolved against the link's own directory", async () => {
    await withHome(async (home, binary, link) => {
      fs.symlinkSync(path.relative(path.dirname(link), binary), link)
      expect(await Shell.ownedLinks(binary, home)).toEqual([link])
      expect(await Shell.removeLink(link, binary)).toBe(true)
    })
  })

  test("a link is ours when it points at the binary through another link", async () => {
    await withHome(async (home, binary, link) => {
      fs.symlinkSync(binary, link)
      // process.execPath can be the link rather than its target, and a second
      // link then points at the same real binary: still ours.
      const elsewhere = path.join(home, "bin2", "rafikicode")
      fs.mkdirSync(path.dirname(elsewhere), { recursive: true })
      fs.symlinkSync(binary, elsewhere)
      expect(await Shell.ownsLink(elsewhere, link)).toBe(true)
      // The path the command reports as the binary is never removed as a link,
      // whether it is the real file or the link the user ran.
      expect(await Shell.ownsLink(link, link)).toBe(false)
      expect(await Shell.ownsLink(binary, binary)).toBe(false)
      expect(fs.existsSync(link)).toBe(true)
    })
  })
})
