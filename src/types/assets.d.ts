/** Bundled variable font (side-effect CSS import). */
declare module '@fontsource-variable/space-grotesk';

/** Static asset imports (Vite returns the bundled URL). */
declare module '*.svg' {
  const url: string;
  export default url;
}

declare module '*.png' {
  const url: string;
  export default url;
}
