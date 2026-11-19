// Small line-icon set (24x24, drawn with the current text colour). Replaces text symbols
// such as ☼ ♧ ⌁, which look different (and blurry) on every device.
const P={
 volume:'<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
 quiet:'<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/>',
 peak:'<path d="M3 12h3l3-7 4 14 3-7h5"/>',
 zap:'<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
 thermometer:'<path d="M14 14.76V4.5a2 2 0 0 0-4 0v10.26a4 4 0 1 0 4 0Z"/><path d="M12 10v7"/>',
 droplet:'<path d="M12 3s6 6.2 6 10.5a6 6 0 0 1-12 0C6 9.2 12 3 12 3Z"/>',
 wifi:'<path d="M2 9a14.5 14.5 0 0 1 20 0"/><path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><path d="M12 19.5h.01"/>',
 battery:'<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2"/><path d="M6 10.5v3"/><path d="M10 10.5v3"/>',
 gauge:'<path d="M3.3 19a10 10 0 1 1 17.4 0"/><path d="m12 14 4-4"/><circle cx="12" cy="14" r="1.2" class="fill"/>',
 pencil:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
 'chevron-down':'<path d="m6 9 6 6 6-6"/>',
 'chevron-up':'<path d="m18 15-6-6-6 6"/>',
 help:'<path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
 locate:'<circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="2.6" class="fill"/>',
 fit:'<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/><circle cx="12" cy="12" r="2.6" class="fill"/>',
 close:'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
 navigate:'<path d="M3 11 22 2l-9 19-2-8z"/>',
 warning:'<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
 check:'<path d="M20 6 9 17l-5-5"/>',
 plus:'<path d="M12 5v14"/><path d="M5 12h14"/>',
 needle:'<path d="M12 2.5 16 12H8z" class="fill red"/><path d="M12 21.5 8 12h8z" class="fill grey"/>',
 dot:'<circle cx="12" cy="12" r="5" class="fill"/>',
 'dot-dashed':'<circle cx="12" cy="12" r="6" stroke-dasharray="3 2.5"/>'
};
export function icon(name){return `<svg class="ic ic-${name}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${P[name]||''}</svg>`}
// Fill every <span data-icon="name"> in the page with its icon.
export function hydrateIcons(root=document){root.querySelectorAll('[data-icon]').forEach(el=>{el.innerHTML=icon(el.dataset.icon)})}
