/**
 * Runs before first paint, so the correct theme is on <html> before the browser
 * paints anything. Without this the page renders light, then flips — the classic
 * dark-mode flash. It is deliberately inline and dependency-free for that reason.
 */
const SCRIPT = `(function(){try{
var c=localStorage.getItem('buhc-theme');
var dark=c==='dark'||(c!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
var r=document.documentElement;
r.dataset.theme=dark?'dark':'light';
r.style.colorScheme=dark?'dark':'light';
}catch(e){}})();`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
