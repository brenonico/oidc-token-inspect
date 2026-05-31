/// <reference types="vite/client" />

// Raw CSS text import (Vite `?inline`): used to inject the panel's stylesheet
// into a closed Shadow DOM. Vite provides `*.css` typings, but the explicit
// `?inline` form needs its own declaration.
declare module "*.css?inline" {
  const css: string;
  export default css;
}
