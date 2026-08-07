/// <reference types="vite/client" />

declare module '*.vue?raw' {
  const source: string;
  export default source;
}

declare module '*.css?raw' {
  const source: string;
  export default source;
}
