import { readFileSync, writeFileSync } from 'node:fs';
const css = readFileSync('base.css', 'utf8'), js = readFileSync('base.js', 'utf8'), logo = readFileSync('logo.b64', 'utf8');
for (const [file, title, src] of [['worca-workspace.html', 'worca Org Workspace', 'tenant.js'], ['worca-console.html', 'worca Platform Console', 'platform.js']]) {
  const html = `<title>${title}</title>
<meta name="description" content="Click-through prototype">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Poppins:wght@300;400;500;600;700&display=swap">
<style>
${css}
:root{--logo-mask:url(data:image/png;base64,${logo});}
</style>
<div id="root"></div>
<script>
${js}
${readFileSync(src, 'utf8')}
</script>
`;
  writeFileSync(file, html);
  console.log(file, html.length);
}
