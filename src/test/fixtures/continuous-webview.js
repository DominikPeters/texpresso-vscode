/* Acceptance driver injected before the production preview. */
(() => {
  const api=acquireVsCodeApi(), identities=new WeakMap(), receivedFrames=new Map(), displayedFrames=new Map();let next=0,lastDemand;
  let holdNextDecode=false,holdColor,decodeGate=0;const heldDecodes=[];
  const nativeDecode=HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode=async function(){
    await nativeDecode.call(this);
    if(holdNextDecode){
      // A neighboring decode can already be queued when the action is armed.
      // Match the controlled fixture pixel before consuming its one-shot gate.
      let matches=true;
      if(holdColor){const probe=document.createElement('canvas');probe.width=probe.height=1;const ctx=probe.getContext('2d');
        ctx.drawImage(this,0,0,1,1,0,0,1,1);const pixel=ctx.getImageData(0,0,1,1).data;matches=holdColor.every((value,index)=>pixel[index]===value);}
      if(matches){holdNextDecode=false;await new Promise(resolve=>{heldDecodes.push(resolve);report('decode-held',{decodeGate:++decodeGate,color:holdColor});});}
    }
  };
  const initialFormat=__FORMAT__, initialZoom=__ZOOM__;
  Element.prototype.setPointerCapture=()=>{}; // Synthetic test pointers have no native capture ID.
  const identity=node=>{if(!node)return undefined;if(!identities.has(node))identities.set(node,++next);return identities.get(node);};
  const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const snapshot=()=>{
    const viewport=document.getElementById('viewport'), view=viewport.getBoundingClientRect();
    const sheets=[...document.querySelectorAll('.page-sheet')].map(sheet=>{
      const rect=sheet.getBoundingClientRect(),vector=sheet.querySelector('.page-vector:not([hidden]) .texpresso-svg-layer.active > svg'),raster=sheet.querySelector('.page-raster:not([hidden]) > canvas'),image=sheet.querySelector('.page-image');
      const header=displayedFrames.get(Number(sheet.dataset.page)),bounds=header?.bounds,text=header?.textBounds;
      const marker=vector?.querySelector('[fill="#246"]');let ink=null;
      if(marker){const mark=marker.getBoundingClientRect();ink={left:mark.left-view.left,right:mark.right-view.left};}
      else if(raster&&raster.width>1){
        const row=raster.getContext('2d').getImageData(0,Math.floor(raster.height/2),raster.width,1).data;let first=-1,last=-1;
        for(let x=0;x<raster.width;x++){if(row[x*4]===34&&row[x*4+1]===68&&row[x*4+2]===102){if(first<0)first=x;last=x;}}
        if(first>=0){const image=raster.getBoundingClientRect();ink={left:image.left-view.left+first/raster.width*image.width,right:image.left-view.left+(last+1)/raster.width*image.width};}
      }
      return {page:Number(sheet.dataset.page),left:rect.left-view.left,right:rect.right-view.left,width:rect.width,top:rect.top-view.top,bottom:rect.bottom-view.top,height:rect.height,ink,
        projectedText:text&&bounds?{left:rect.left-view.left+(text[0]-bounds[0])/(bounds[2]-bounds[0])*rect.width,right:rect.left-view.left+(text[2]-bounds[0])/(bounds[2]-bounds[0])*rect.width}:null,
        visible:rect.bottom>view.top&&rect.top<view.bottom,rendered:!!vector||!!raster&&raster.width>0||!!image&&!image.hidden&&image.naturalWidth>0,
        root:identity(vector||raster||image),sourceSequence:displayedFrames.get(Number(sheet.dataset.page))?.sequence,highlightBoxes:[...sheet.querySelectorAll('.source-highlight-box')].map(box=>({left:box.style.left,top:box.style.top,width:box.style.width,height:box.style.height,color:getComputedStyle(box).backgroundColor})),highlightHidden:sheet.querySelector('.page-highlight')?.hidden,highlightLeft:sheet.querySelector('.page-highlight')?.style.left,highlightTop:sheet.querySelector('.page-highlight')?.style.top,pixel:raster&&raster.width>1?[...raster.getContext('2d').getImageData(1,1,1,1).data]:undefined,detailSrc:sheet.querySelector('.page-detail')?.getAttribute('src'),detailHidden:sheet.querySelector('.page-detail')?.hidden,links:sheet.querySelectorAll('.page-link').length};
    });
    const centered=sheets.find(sheet=>sheet.top<=viewport.clientHeight/2&&sheet.bottom>=viewport.clientHeight/2),topSheet=sheets.find(sheet=>sheet.top<=0&&sheet.bottom>0);
    return {width:viewport.clientWidth,scrollLeft:viewport.scrollLeft,scrollWidth:viewport.scrollWidth,zoom:document.getElementById('zoom').value,
      centerPoint:centered?{page:centered.page,fraction:(viewport.clientHeight/2-centered.top)/centered.height}:null,
      topPoint:topSheet?{page:topSheet.page,fraction:-topSheet.top/topSheet.height}:null,
      stackHeight:document.querySelector('.page-stack').getBoundingClientRect().height,epoch:lastDemand?.epoch,scrollTop:viewport.scrollTop,toolbar:Number(document.getElementById('page').value)-1,toolbarValue:document.getElementById('page').value,toolbarDisabled:document.getElementById('page').disabled,height:viewport.clientHeight,
      lensSrc:document.getElementById('lensImage').getAttribute('src'),lensIdentity:identity(document.getElementById('lensImage')),lensWidth:document.getElementById('lensImage').naturalWidth,lensHidden:document.getElementById('lens').hidden,lensConnected:document.getElementById('lensImage').isConnected,rememberedDetailSrc:rememberedDetail?.getAttribute('src'),rememberedDetailConnected:rememberedDetail?.isConnected,
      shells:sheets,shellCount:sheets.length,residentBytes:Number(viewport.dataset.residentBytes),statusHidden:document.getElementById('status').hidden};
  };
  const report=(continuousCheck,extra={})=>api.postMessage({continuousCheck,...snapshot(),...extra});
  window.continuousApi=()=>({getState:()=>({format:initialFormat,zoom:initialZoom,page:0}),setState:()=>{},postMessage:message=>{
    if(message.type==='ready'||message.type==='viewport')lastDemand=message;
    if(message.type==='decoded'&&message.displayed!==false&&receivedFrames.has(message.id)){displayedFrames.set(message.page,receivedFrames.get(message.id));}
    api.postMessage(message);
    if(message.type==='ready'||message.type==='decoded')paint().then(()=>report(message.type,{request:message.id,page:message.page,displayed:message.displayed,stale:message.stale}));
  }});
  let rememberedLink, rememberedDetail, gestureSheet;
  window.addEventListener('message',async event=>{
    if(event.data.type==='image'&&event.data.header){receivedFrames.set(event.data.header.requestId,event.data.header);}
    const action=event.data.continuousAction;if(!action)return;
    try {
      const viewport=document.getElementById('viewport');
      const sheet=()=>document.querySelector(`.page-sheet[data-page="${action.page}"]`);
      if(action.name==='arm-decode'){holdColor=action.color;holdNextDecode=true;}
      if(action.name==='release-decode'){heldDecodes.shift()?.();}
      if(action.name==='zoom'){const zoom=document.getElementById('zoom');zoom.value=String(action.value);zoom.dispatchEvent(new Event('change'));}
      if(action.name==='scroll'){if(action.top!==undefined)viewport.scrollTop=action.top;if(action.left!==undefined)viewport.scrollLeft=action.left;viewport.dispatchEvent(new Event('scroll'));}
      if(action.name==='resize'){document.documentElement.style.width=action.width+'px';document.body.style.width=action.width+'px';}
      if(action.name==='landmark'){const target=sheet();if(!target)throw Error('No landmark page '+action.page);const rect=target.getBoundingClientRect(),clip=viewport.getBoundingClientRect();viewport.scrollTop+=rect.top-clip.top+rect.height*action.fraction-viewport.clientHeight/2;viewport.dispatchEvent(new Event('scroll'));}
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
