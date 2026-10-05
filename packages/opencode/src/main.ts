// Entry point of the compiled binary.
//
// The bundler evaluates modules with a top level await (global.ts, which
// creates the data and temporary folders as it loads) ahead of the static
// imports listed before them, so in a compiled binary the folder doctor and the
// crash handlers that src/index.ts imports first ran after the folders were
// already in use: a read only /tmp ended every command with a raw EROFS. Here
// they are static imports, and everything else is loaded by a dynamic import
// that cannot start before they have run.
import "./rafiki/folders-early"
import "./rafiki/startup-guard"

await import("./index")
