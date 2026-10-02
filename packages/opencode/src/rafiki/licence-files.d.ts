// The repository's licence and notice files have no extension. They are
// imported as text (rafiki/licence.ts) so that the compiled binary carries them.
declare module "*/LICENSE" {
  const text: string
  export default text
}

declare module "*/NOTICE" {
  const text: string
  export default text
}
