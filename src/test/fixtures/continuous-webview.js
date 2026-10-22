/* Acceptance driver injected before the production preview. */
(() => {
  const api=acquireVsCodeApi(), identities=new WeakMap();let next=0,lastDemand;
  const initialFormat=__FORMAT__, initialZoom=__ZOOM__;
  Element.prototype.setPointerCapture=()=>{}; // Synthetic test pointers have no native capture ID.
  const identity=node=>{if(!node)return undefined;if(!identities.has(node))identities.set(node,++next);return identities.get(node);};
  const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const snapshot=()=>{
    const viewport=document.getElementById('viewport'), view=viewport.getBoundingClientRect();
    const sheets=[...document.querySelectorAll('.page-sheet')].map(sheet=>{
      const rect=sheet.getBoundingClientRect(),vector=sheet.querySelector('.page-vector svg'),raster=sheet.querySelector('.page-raster canvas'),image=sheet.querySelector('.page-image');
      return {page:Number(sheet.dataset.page),top:rect.top-view.top,bottom:rect.bottom-view.top,height:rect.height,
        visible:rect.bottom>view.top&&rect.top<view.bottom,rendered:!!vector||!!raster&&raster.width>0||!!image&&!image.hidden&&image.naturalWidth>0,
        root:identity(vector||raster||image),detailSrc:sheet.querySelector('.page-detail')?.getAttribute('src'),detailHidden:sheet.querySelector('.page-detail')?.hidden,links:sheet.querySelectorAll('.page-link').length};
    });
    return {stackHeight:document.querySelector('.page-stack').getBoundingClientRect().height,epoch:lastDemand?.epoch,scrollTop:viewport.scrollTop,toolbar:Number(document.getElementById('page').value)-1,toolbarValue:document.getElementById('page').value,toolbarDisabled:document.getElementById('page').disabled,height:viewport.clientHeight,
      lensSrc:document.getElementById('lensImage').getAttribute('src'),lensIdentity:identity(document.getElementById('lensImage')),lensWidth:document.getElementById('lensImage').naturalWidth,lensHidden:document.getElementById('lens').hidden,lensConnected:document.getElementById('lensImage').isConnected,rememberedDetailSrc:rememberedDetail?.getAttribute('src'),rememberedDetailConnected:rememberedDetail?.isConnected,
      shells:sheets,shellCount:sheets.length,residentBytes:Number(viewport.dataset.residentBytes),statusHidden:document.getElementById('status').hidden};
  };
  const report=(continuousCheck,extra={})=>api.postMessage({continuousCheck,...snapshot(),...extra});
  window.continuousApi=()=>({getState:()=>({format:initialFormat,zoom:initialZoom,page:0}),setState:()=>{},postMessage:message=>{
    if(message.type==='ready'||message.type==='viewport')lastDemand=message;
    api.postMessage(message);
    if(message.type==='ready'||message.type==='decoded')paint().then(()=>report(message.type,{request:message.id,page:message.page}));
  }});
  let rememberedLink, rememberedDetail, gestureSheet;
  window.addEventListener('message',async event=>{
    const action=event.data.continuousAction;if(!action)return;
    try {
      const viewport=document.getElementById('viewport');
      const sheet=()=>document.querySelector(`.page-sheet[data-page="${action.page}"]`);
      if(action.name==='scroll'){viewport.scrollTop=action.top;viewport.dispatchEvent(new Event('scroll'));}
      if(action.name==='jump'){const page=document.getElementById('page');page.value=String(action.page+1);page.dispatchEvent(new Event('change'));}
      if(action.name==='link'){const link=sheet()?.querySelector('.page-link');if(!link)throw Error('No page link '+action.page);link.click();}
      if(action.name==='remember-link'){rememberedLink=sheet()?.querySelector('.page-link');if(!rememberedLink)throw Error('No saved link');}
      if(action.name==='click-remembered')rememberedLink.click();
      if(action.name==='remember-detail'){rememberedDetail=sheet()?.querySelector('.page-detail');if(!rememberedDetail?.getAttribute('src'))throw Error('No detail to remember');}
      if(action.name==='lens'){
        const toggle=document.getElementById('magnify');if(toggle.getAttribute('aria-pressed')!=='true')toggle.click();
        gestureSheet=sheet();if(!gestureSheet)throw Error('No lens page '+action.page);
        const rect=gestureSheet.getBoundingClientRect(),clip=viewport.getBoundingClientRect();
        gestureSheet.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:17,clientX:Math.max(clip.left+12,Math.min(clip.right-12,rect.left+rect.width*.5)),clientY:Math.max(clip.top+12,Math.min(clip.bottom-12,rect.top+rect.height*.5))}));
      }
      if(action.name==='close-lens')gestureSheet?.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,pointerId:17}));
      if(action.name==='inverse'){
        const target=sheet();if(!target)throw Error('No inverse page '+action.page);const rect=target.getBoundingClientRect();
        target.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true,clientX:rect.left+rect.width*.5,clientY:rect.top+rect.height*.5}));
      }
      await paint();report('action',{action:action.id});
    }catch(error){api.postMessage({continuousCheck:'failure',action:action.id,error:String(error.stack||error)});}
  });
})();
