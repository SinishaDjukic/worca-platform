// Vite's ?raw imports (test/unit/shared/deployment-config.test.ts reads the wrangler configs).
declare module '*?raw' {
  const text: string;
  export default text;
}
