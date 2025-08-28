/** Wersja aplikacji (pokaże się w nagłówku i welcome) */
const APP_VERSION = "v1.1.0";

/***** Ustawienia kompresji *****/
const MAX_DIM = 1600;        // dłuższy bok przy "Skompresowana"
const THUMB_MAX = 360;       // dłuższy bok miniatury (dataURL)
const QUALITY = 0.75;
const SUPPORTED_MIME = new Set(['image/jpeg','image/png','image/webp']);

/***** IndexedDB *****/
const DB_NAME='mobileGalleryDB', DB_VERSION=3, STORE='photos';

/* ====== Stan ====== */
let currentFilter='all', searchTerm='';
let pendingBlob=null, pendingThumb=null, editingId=null;
let pressTimer=null, pressedCardId=null;

const LS_QUALITY_KEY = 'gallery.quality';
const DEFAULT_QUALITY = 'compressed';
function loadQualitySetting(){ try { return localStorage.getItem(LS_QUALITY_KEY) || DEFAULT_QUALITY; } catch { return DEFAULT_QUALITY; } }
function saveQualitySetting(v){ try { localStorage.setItem(LS_QUALITY_KEY, v); } catch {} }
let qualitySetting = loadQualitySetting();

/* ====== DOM ====== */
const grid=document.getElementById('grid');
const emptyState=document.getElementById('empty');
const filters=document.getElementById('filters');
const searchInput=document.getElementById('searchInput');
const clearSearch=document.getElementById('clearSearch');
const countBadge=document.getElementById('countBadge');
const camBtn=document.getElementById('camBtn');
const galBtn=document.getElementById('galBtn');
const cameraInput=document.getElementById('cameraInput');
const galleryInput=document.getElementById('galleryInput');

const sheet=document.getElementById('sheet');
const sheetTitle=document.getElementById('sheetTitle');
const openSheetBtn=document.getElementById('openSheet');
const cancelBtn=document.getElementById('cancelBtn');
const saveBtn=document.getElementById('saveBtn');
const titleInput=document.getElementById('titleInput');
const descInput=document.getElementById('descInput');
const catInput=document.getElementById('catInput');

const settingsSheet=document.getElementById('settingsSheet');
const openSettings=document.getElementById('openSettings');
const settingsCancel=document.getElementById('settingsCancel');
const settingsSave=document.getElementById('settingsSave');

const actionMenu=document.getElementById('actionMenu');
const actEdit=document.getElementById('actEdit');
const actDelete=document.getElementById('actDelete');
const actCancel=document.getElementById('actCancel');

const lightbox=document.getElementById('lightbox');
const lightImg=document.getElementById('lightImg');
const lightTitle=document.getElementById('lightTitle');
const lightDesc=document.getElementById('lightDesc');
const closeLightbox=document.getElementById('closeLightbox');
const prevBtn=document.getElementById('prevBtn');
const nextBtn=document.getElementById('nextBtn');
const playPauseBtn=document.getElementById('playPauseBtn');

const btnExport=document.getElementById('btnExport');
const importInput=document.getElementById('importInput');
const btnClearUnsupported=document.getElementById('btnClearUnsupported');

const toast=document.getElementById('toast');

/* ===== Helpery UI ===== */
function showToast(msg){ toast.textContent=msg; toast.classList.add('show'); setTimeout(()=>toast.classList.remove('show'),1500); }
function attachRippleOrigin(btn){ btn.addEventListener('pointerdown', e=>{ const r=btn.getBoundingClientRect(); btn.style.setProperty('--x',(e.clientX-r.left)+'px'); btn.style.setProperty('--y',(e.clientY-r.top)+'px'); }); }
[...document.querySelectorAll('.ripple')].forEach(attachRippleOrigin);

function openSheet(){ sheet.classList.add('open'); sheet.setAttribute('aria-hidden','false'); }
function closeSheet(){ sheet.classList.remove('open'); sheet.setAttribute('aria-hidden','true'); titleInput.value=''; descInput.value=''; catInput.value='inne'; pendingBlob=null; pendingThumb=null; editingId=null; sheetTitle.textContent='Dodaj informacje o zdjęciu'; }

function openSettingsSheet(){
  settingsSheet.querySelectorAll('input[name="quality"]').forEach(r => r.checked = (r.value === qualitySetting));
  settingsSheet.classList.add('open'); settingsSheet.setAttribute('aria-hidden','false');
}
function closeSettingsSheet(){ settingsSheet.classList.remove('open'); settingsSheet.setAttribute('aria-hidden','true'); }

function openActionMenu(cardId){ pressedCardId = cardId; actionMenu.classList.add('open'); actionMenu.setAttribute('aria-hidden','false'); }
function closeActionMenu(){ actionMenu.classList.remove('open'); actionMenu.setAttribute('aria-hidden','true'); pressedCardId = null; }

/* ===== Welcome overlay ===== */
function showWelcomeOverlay(){
  const el = document.getElementById('welcome');
  const verEl = document.getElementById('welcomeVer');
  if(!el) return;
  if(verEl) verEl.textContent = APP_VERSION;
  el.addEventListener('click', ()=>hideWelcomeOverlay(), { once:true });
  setTimeout(()=>hideWelcomeOverlay(), 1800);
}
function hideWelcomeOverlay(){
  const el = document.getElementById('welcome');
  if(!el) return;
  el.classList.add('hide');
  setTimeout(()=>{ try{ el.remove(); }catch{} }, 600);
}

/* ===== DB ===== */
function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded=()=>{ 
      const db=req.result;
      if(!db.objectStoreNames.contains(STORE)){
        const os=db.createObjectStore(STORE,{keyPath:'id'});
        os.createIndex('by_createdAt','createdAt');
        os.createIndex('by_category','category');
      }
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
function txWrap(db,mode,fn){ return new Promise((res,rej)=>{ const tx=db.transaction(STORE,mode); fn(tx.objectStore(STORE)); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); }
async function dbAddOrUpdate(photo){ const db=await openDB(); await txWrap(db,'readwrite',s=>s.put(photo)); }
async function dbDelete(id){ const db=await openDB(); await txWrap(db,'readwrite',s=>s.delete(id)); }
async function dbGetAll(){ const db=await openDB(); return new Promise((res,rej)=>{ const out=[]; const tx=db.transaction(STORE,'readonly'); const idx=tx.objectStore(STORE).index('by_createdAt'); idx.openCursor(null,'prev').onsuccess=e=>{ const c=e.target.result; if(c){ out.push(c.value); c.continue(); } }; tx.oncomplete=()=>res(out); tx.onerror=()=>rej(tx.error); }); }
async function dbGetById(id){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,'readonly'); const s=tx.objectStore(STORE); const r=s.get(id); r.onsuccess=()=>res(r.result||null); r.onerror=()=>rej(r.error); }); }

/* ===== Kompresja / miniatury ===== */
function supportsWebP(){ try{ const c=document.createElement('canvas'); return !!c.toDataURL && c.toDataURL('image/webp').startsWith('data:image/webp'); }catch{ return false; } }
async function blobToDrawable(blob){ if('createImageBitmap' in window){ try{ return await createImageBitmap(blob);}catch{} } const url=URL.createObjectURL(blob); try{ const img=new Image(); img.decoding='async'; await new Promise((res,rej)=>{ img.onload=res; img.onerror=rej; img.src=url; }); return img; } finally{ URL.revokeObjectURL(url); } }

async function convertHeicIfPossible(file){
  const isHeic=/image\/heic|image\/hei[f|c]/i.test(file.type)||/\.heic$/i.test(file.name||'');
  if(!isHeic) return file;
  if(typeof window.heic2any!=='function'){
    alert('To zdjęcie jest w HEIC. Włącz internet lub ustaw Aparat → Format: „Najbardziej zgodne” (JPEG).');
    throw new Error('HEIC');
  }
  const converted=await window.heic2any({blob:file,toType:'image/jpeg',quality:0.97});
  return Array.isArray(converted)?converted[0]:converted;
}
async function compressBlob(blob){
  if(blob.size<300*1024) return blob;
  let src; try{ src=await blobToDrawable(blob);}catch{ return blob; }
  let {width:w,height:h}=src,tw=w,th=h;
  if(Math.max(w,h)>MAX_DIM){
    if(w>=h){tw=MAX_DIM;th=Math.round(h/w*MAX_DIM);} else {th=MAX_DIM;tw=Math.round(w/h*MAX_DIM);}
  }
  const c=document.createElement('canvas'); c.width=tw; c.height=th;
  c.getContext('2d',{alpha:false}).drawImage(src,0,0,tw,th);
  const mime = supportsWebP()? 'image/webp' : 'image/jpeg';
  const out=await new Promise(res=>c.toBlob(b=>res(b),mime,QUALITY));
  return (out && out.size < blob.size) ? out : blob;
}
async function makeThumbDataURL(blob){
  let src = await blobToDrawable(blob);
  let {width:w,height:h}=src,tw=w,th=h;
  if(Math.max(w,h)>THUMB_MAX){
    if(w>=h){tw=THUMB_MAX;th=Math.round(h/w*THUMB_MAX);} else {th=THUMB_MAX;tw=Math.round(w/h*THUMB_MAX);}
  }
  const c=document.createElement('canvas'); c.width=tw; c.height=th;
  c.getContext('2d',{alpha:false}).drawImage(src,0,0,tw,th);
  const mime = supportsWebP()? 'image/webp' : 'image/jpeg';
  return c.toDataURL(mime, 0.8);
}

/* ===== Render ===== */
let _viewItems=[];
async function render(){
  grid.innerHTML='';
  let items=await dbGetAll();
  if(currentFilter!=='all') items=items.filter(x=>x.category===currentFilter);
  if(searchTerm.trim()){
    const q=searchTerm.trim().toLowerCase();
    items=items.filter(x=>(x.title||'').toLowerCase().includes(q)||(x.description||'').toLowerCase().includes(q));
  }
  _viewItems = items;
  countBadge.textContent=String(items.length);
  emptyState.hidden = items.length>0;

  for(const it of items){
    const card=document.createElement('div'); card.className='card'; card.dataset.id=it.id;

    const wrap=document.createElement('div'); wrap.className='img-wrap';
    const img=document.createElement('img'); img.alt=it.title||'Zdjęcie'; img.loading='lazy'; img.decoding='async';
    const unsupported = !SUPPORTED_MIME.has(it.mime||'');

    if(unsupported || !it.thumbDataURL){
      img.src='data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="100%" height="100%" fill="%2318222f"/><text x="50%" y="50%" fill="%23cbd5e1" font-size="24" font-family="Arial" text-anchor="middle" dominant-baseline="middle">Nie można wyświetlić obrazu</text></svg>';
    } else {
      img.src = it.thumbDataURL;
      img.addEventListener('click',()=>openLightboxById(it.id));
    }

    const badge=document.createElement('div'); badge.className='badge';
    const map={krajobraz:'Krajobraz',ludzie:'Ludzie',zwierzeta:'Zwierzęta',inne:'Inne'};
    badge.textContent = unsupported ? 'Niewspierany' : (map[it.category]||'Inne');

    wrap.appendChild(img); wrap.appendChild(badge);
    const meta=document.createElement('div'); meta.className='meta';
    const t=document.createElement('div'); t.className='title'; t.textContent=it.title||'(bez tytułu)';
    const d=document.createElement('div'); d.className='desc'; d.textContent=it.description||'';
    meta.appendChild(t); meta.appendChild(d);

    card.appendChild(wrap); card.appendChild(meta);
    grid.appendChild(card);
  }
}

/* ===== Lightbox + slideshow + swipe ===== */
let _lightboxURL=null,_currentIndex=-1,_slideTimer=null; const SLIDE_INTERVAL_MS=3200;

function setImageFadeLoading(){ lightImg.classList.remove('loaded'); lightImg.onload=()=>lightImg.classList.add('loaded'); }
function openLightboxById(id){ const idx=_viewItems.findIndex(x=>x.id===id); if(idx>=0) openLightboxAt(idx); }
function openLightboxAt(index){
  _currentIndex=(index+_viewItems.length)%_viewItems.length;
  const it=_viewItems[_currentIndex];
  if(_lightboxURL){ try{URL.revokeObjectURL(_lightboxURL);}catch{} _lightboxURL=null; }

  setImageFadeLoading();
  const unsupported = !SUPPORTED_MIME.has(it.mime||'');
  if(unsupported){ lightImg.src=it.thumbDataURL||''; }
  else{
    const url=URL.createObjectURL(it.blob);
    _lightboxURL=url;
    lightImg.onerror=()=>{ lightImg.onerror=null; lightImg.src=it.thumbDataURL||''; };
    lightImg.src=url;
  }
  lightImg.alt=it.title||'';
  lightTitle.textContent=it.title||'(bez tytułu)';
  lightDesc.textContent=it.description||'';

  lightbox.classList.add('open'); lightbox.setAttribute('aria-hidden','false');
}
function closeLB(){
  lightbox.classList.remove('open'); lightbox.setAttribute('aria-hidden','true');
  stopSlideshow();
  if(_lightboxURL){ try{URL.revokeObjectURL(_lightboxURL);}catch{} _lightboxURL=null; }
}
closeLightbox.addEventListener('click',closeLB);
lightbox.addEventListener('click',e=>{ if(e.target===lightbox) closeLB(); });

function showPrev(){ if(!_viewItems.length) return; openLightboxAt(_currentIndex-1); }
function showNext(){ if(!_viewItems.length) return; openLightboxAt(_currentIndex+1); }
prevBtn.addEventListener('click',showPrev);
nextBtn.addEventListener('click',showNext);

function startSlideshow(){ if(_slideTimer) return; playPauseBtn.textContent='⏸'; _slideTimer=setInterval(()=>{showNext();},SLIDE_INTERVAL_MS); }
function stopSlideshow(){ if(_slideTimer){ clearInterval(_slideTimer); _slideTimer=null; } playPauseBtn.textContent='⏵'; }
playPauseBtn.addEventListener('click',()=>{ _slideTimer?stopSlideshow():startSlideshow(); });

/* Swipe na obrazku */
function setupSwipeWithFeedback(targetEl, { onSwipeLeft, onSwipeRight, threshold = 50, maxY = 60 } = {}) {
  let startX = 0, startY = 0;
  targetEl.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    targetEl.style.transition = 'none';
  }, { passive: true });
  targetEl.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dy) < 90) targetEl.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  targetEl.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    targetEl.style.transition = 'transform .18s ease';
    targetEl.style.transform = 'translateX(0)';
    if (Math.abs(dx) >= threshold && Math.abs(dy) <= maxY) (dx < 0 ? onSwipeLeft : onSwipeRight)?.();
  }, { passive: true });
}
setupSwipeWithFeedback(lightImg, { onSwipeLeft: showNext, onSwipeRight: showPrev });

/* ===== Filtry + Szukaj ===== */
filters.addEventListener('click',async e=>{
  const btn=e.target.closest('button[data-filter]'); if(!btn || btn.id==='openSettings') return;
  [...filters.querySelectorAll('button')].forEach(b=>b.classList.remove('active'));
  btn.classList.add('active'); currentFilter=btn.dataset.filter; await render();
});
searchInput.addEventListener('input',()=>{ searchTerm=searchInput.value; render(); });
clearSearch.addEventListener('click',()=>{ searchInput.value=''; searchTerm=''; render(); });

/* ===== Sheet (dodawanie/edycja) ===== */
openSheetBtn.addEventListener('click',openSheet);
cancelBtn.addEventListener('click',closeSheet);
saveBtn.addEventListener('click',async ()=>{
  if (editingId){
    const old = await dbGetById(editingId);
    if (!old) { closeSheet(); return; }
    await dbAddOrUpdate({ ...old, title:titleInput.value.trim(), description:descInput.value.trim(), category:catInput.value });
    editingId=null; closeSheet(); await render(); showToast('Zapisano zmiany ✓'); return;
  }
  if(!pendingBlob || !pendingThumb){ alert('Najpierw wybierz zdjęcie z Aparatu lub Galerii.'); return; }
  const item = {
    id: crypto.randomUUID(),
    title: titleInput.value.trim(),
    description: descInput.value.trim(),
    category: catInput.value,
    createdAt: Date.now(),
    mime: pendingBlob.type || 'image/jpeg',
    blob: pendingBlob,
    thumbDataURL: pendingThumb
  };
  await dbAddOrUpdate(item);
  pendingBlob=null; pendingThumb=null; closeSheet(); await render(); showToast('Dodano zdjęcie ✓');
});

/* ===== Ustawienia jakości ===== */
openSettings.addEventListener('click', openSettingsSheet);
settingsCancel.addEventListener('click', closeSettingsSheet);
settingsSave.addEventListener('click', ()=>{
  const val = settingsSheet.querySelector('input[name="quality"]:checked')?.value || DEFAULT_QUALITY;
  qualitySetting = val; saveQualitySetting(val);
  closeSettingsSheet(); showToast(`Ustawiono: ${val==='full'?'Pełna jakość':'Skompresowana'}`);
});

/* ===== Długie przytrzymanie: Edycja/Usuń ===== */
grid.addEventListener('touchstart',e=>{
  const card=e.target.closest('.card'); if(!card) return;
  const id=card.dataset.id;
  pressTimer=setTimeout(()=>{ openActionMenu(id); },650);
},{passive:true});
grid.addEventListener('touchend',()=>clearTimeout(pressTimer),{passive:true});
actCancel.addEventListener('click', closeActionMenu);
actDelete.addEventListener('click', async ()=>{
  if(!pressedCardId) return;
  if(confirm('Usunąć to zdjęcie?')){ await dbDelete(pressedCardId); await render(); showToast('Usunięto zdjęcie'); }
  closeActionMenu();
});
actEdit.addEventListener('click', async ()=>{
  if(!pressedCardId) return;
  const it = await dbGetById(pressedCardId);
  closeActionMenu(); if(!it) return;
  sheetTitle.textContent='Edytuj informacje o zdjęciu';
  titleInput.value=it.title||''; descInput.value=it.description||''; catInput.value=it.category||'inne';
  editingId = it.id; openSheet();
});

/* ===== Pliki (Aparat/Galeria) ===== */
camBtn.addEventListener('click',()=>cameraInput.click());
galBtn.addEventListener('click',()=>galleryInput.click());

async function prepareBlobAndThumb(file){
  const conv = await convertHeicIfPossible(file);
  let finalBlob = conv;
  if (qualitySetting === 'compressed'){ finalBlob = await compressBlob(conv); }
  const thumb = await makeThumbDataURL(finalBlob);
  return { blob: finalBlob, thumb };
}

cameraInput.addEventListener('change', async (e)=>{
  const file=e.target.files?.[0]; if(!file) return;
  try{
    const { blob, thumb } = await prepareBlobAndThumb(file);
    pendingBlob = blob; pendingThumb = thumb; sheetTitle.textContent='Dodaj informacje o zdjęciu'; openSheet();
  }catch{}
  cameraInput.value='';
});

galleryInput.addEventListener('change', async (e)=>{
  const files=Array.from(e.target.files||[]); if(!files.length) return;
  const [first,...rest]=files;
  try{
    const { blob, thumb } = await prepareBlobAndThumb(first);
    pendingBlob=blob; pendingThumb=thumb; sheetTitle.textContent='Dodaj informacje o zdjęciu'; openSheet();
  }catch{}
  for(const f of rest){
    try{
      const { blob, thumb } = await prepareBlobAndThumb(f);
      await dbAddOrUpdate({ id:crypto.randomUUID(), title:(f.name||'Zdjęcie').replace(/\.[^.]+$/,''), description:'', category:'inne', createdAt:Date.now(), mime:blob.type||'image/jpeg', blob, thumbDataURL:thumb });
    }catch{}
  }
  await render();
  galleryInput.value='';
});

/* ===== Eksport / Import ===== */
btnExport.addEventListener('click', async ()=>{
  const items=await dbGetAll();
  const arr = await Promise.all(items.map(async it=>{
    const b64 = await blobToBase64(it.blob);
    return { id:it.id, title:it.title, description:it.description, category:it.category, createdAt:it.createdAt, mime:it.mime, blobBase64:b64, thumbDataURL:it.thumbDataURL || null };
  }));
  const blob=new Blob([JSON.stringify({version:3, items:arr})], {type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='galeria-export.json'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  showToast('Wyeksportowano ✓');
});
function blobToBase64(blob){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result.split(',')[1]); r.onerror=rej; r.readAsDataURL(blob); }); }

importInput.addEventListener('change', async (e)=>{
  const file=e.target.files?.[0]; if(!file) return;
  try{
    const text=await file.text(); const data=JSON.parse(text);
    if(!data?.items) throw new Error('Zły plik');
    for(const it of data.items){
      try{
        const b = base64ToBlob(it.blobBase64, it.mime||'image/jpeg');
        await dbAddOrUpdate({ id: it.id || crypto.randomUUID(), title: it.title||'', description: it.description||'', category: it.category||'inne', createdAt: it.createdAt||Date.now(), mime: it.mime||'image/jpeg', blob: b, thumbDataURL: it.thumbDataURL || (await makeThumbDataURL(b)) });
      }catch{}
    }
    await render(); showToast('Zaimportowano ✓');
  } catch { alert('Nie udało się zaimportować pliku.'); }
  importInput.value='';
});
function base64ToBlob(b64, mime){ const bin=atob(b64); const len=bin.length; const arr=new Uint8Array(len); for(let i=0;i<len;i++) arr[i]=bin.charCodeAt(i); return new Blob([arr],{type:mime}); }

/* ===== Start ===== */
(async function init(){
  if(navigator.storage && navigator.storage.persist){
    try{
      const persisted=await navigator.storage.persist();
      if(persisted) showToast('Pamięć zabezpieczona ✓');
    }catch{}
  }

  await render();

  const verEl = document.getElementById('appVersion');
  if(verEl) verEl.textContent = APP_VERSION;

  showWelcomeOverlay();

  // sprzątanie niewspieranych – przycisk
  btnClearUnsupported?.addEventListener('click', async ()=>{
    const db=await openDB();
    await new Promise((res,rej)=>{
      const tx=db.transaction(STORE,'readwrite'); const s=tx.objectStore(STORE);
      s.openCursor().onsuccess=e=>{ const c=e.target.result; if(c){ const {mime}=c.value; if(!SUPPORTED_MIME.has(mime||'')) c.delete(); c.continue(); } };
      tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error);
    });
    await render(); showToast('Usunięto niewspierane');
  });
})();