window.addEventListener("DOMContentLoaded", () => {
document.getElementById("resetBtn").addEventListener("click", ()=>{

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    if(!activeIndices.length) return;

    activeIndices.forEach(index=>{

        const data = canvasData[index];

        // restore initial loaded state
        data.x = data.initialX;
        data.y = data.initialY;

        data.scale = data.initialScale;
        data.scaleX = null;
        data.scaleY = null;

        data.rotation = data.initialRotation;

        data.warpAmount = data.initialWarpAmount;
        data.arcAmount = data.initialArcAmount;
        data.opacity = data.initialOpacity;
        data.blurAmount = data.initialBlurAmount;
        data.blendMode = data.initialBlendMode;
        data.blendMode = data.initialBlendMode;

        applyWarpToData(data);
    });

    syncSliders();
});





document.getElementById("saveProgressBtn").addEventListener("click", ()=>{

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    const snapshot = canvasData.map(data=>{

        const mainObj = data.designObject;

        return {

            bgSrc: data.bg.src,
            bgName: data.bgName,

            designSrc: data.designOriginal ? data.designOriginal.src : null,
            designName: data.designName,

            x: mainObj ? mainObj.left : data.x,
            y: mainObj ? mainObj.top : data.y,

            scale: data.scale,

            scaleX: mainObj ? (mainObj.scaleX / data.previewScale) : data.scaleX,
            scaleY: mainObj ? (mainObj.scaleY / data.previewScale) : data.scaleY,

            rotation: mainObj ? mainObj.angle : data.rotation,

            warpAmount: data.warpAmount ?? 0,
            arcAmount: data.arcAmount ?? 0,
            opacity: data.opacity ?? 1,
            blurAmount: data.blurAmount ?? 0,
            blendMode: data.blendMode ?? "normal",

            maskPaths: data.maskPaths ?? [],
            maskPath: data.maskPath ?? null,
            maskEnabled: data.maskEnabled ?? false,
            maskType: data.maskType ?? null,

            filename: data.filename,

            duplicates: (data.extraDesignObjects || []).map(obj=>({

                left: obj.left,
                top: obj.top,

                scaleX: obj.scaleX / data.previewScale,
                scaleY: obj.scaleY / data.previewScale,

                angle: obj.angle
            }))
        };
    });

    const blob = new Blob(
        [JSON.stringify(snapshot, null, 2)],
        {type:'application/json'}
    );

    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'mockup_progress.json';
    a.click();

    URL.revokeObjectURL(url);
});



async function createCanvasPreviewsFromSnapshot(snapshot){

    const container =
        document.getElementById("canvasContainer");

    const loadingIndicator =
        document.getElementById("loadingIndicator");

    container.innerHTML = "";
    canvasData = [];
    activeIndices = [];

    // rebuild source asset pools so future uploads
    // can multiply/populate correctly after JSON load
    backgrounds = [];
    designs = [];

    loadingIndicator.style.display = "block";

    for(let index = 0; index < snapshot.length; index++){

        const saved = snapshot[index];

        loadingIndicator.innerText =
            `Restoring session... ${index + 1} / ${snapshot.length}`;

        const bgImg = await new Promise(resolve=>{

            const img = new Image();

            img.onload = ()=>resolve(img);

            img.src = saved.bgSrc;
        });

        let designImg = null;

        if(saved.designSrc){

            designImg = await new Promise(resolve=>{

                const img = new Image();

                img.onload = ()=>resolve(img);

                img.src = saved.designSrc;
            });

            // restore design source pool
            if(
                !designs.some(
                    d => d.img && d.img.src === saved.designSrc
                )
            ){
                designs.push({
                    img: designImg,
                    name: saved.designName || ""
                });
            }
        }

        // restore background source pool
        if(
            !backgrounds.some(
                b => b.img && b.img.src === saved.bgSrc
            )
        ){
            backgrounds.push({
                img: bgImg,
                name: saved.bgName || ""
            });
        }

        const data = {

            bg: bgImg,
            bgName: saved.bgName,

            designOriginal: designImg,
            designName: saved.designName,

            x: saved.x,
            y: saved.y,

            scale: saved.scale,
            scaleX: saved.scaleX,
            scaleY: saved.scaleY,

            rotation: saved.rotation,

            warpAmount: saved.warpAmount,
            arcAmount: saved.arcAmount,

            opacity: saved.opacity ?? 1,
            blurAmount: saved.blurAmount ?? 0,
            blendMode: saved.blendMode ?? "normal",

            maskPaths:
                saved.maskPaths ||
                (saved.maskPath ? [saved.maskPath] : []),

            maskPath: saved.maskPath ?? null,
            maskEnabled: saved.maskEnabled ?? false,
            maskType: saved.maskType ?? null,

            // restore editable clipping editor state
            clipCurvePoints: saved.maskPath
                ? JSON.parse(JSON.stringify(saved.maskPath))
                : [],
            clipPolygonClosed:
                !!(
                    saved.maskEnabled &&
                    saved.maskPath &&
                    saved.maskPath.length >= 3
                ),

            filename: saved.filename,

            extraDesignObjects: [],

            initialX: saved.x,
            initialY: saved.y,

            initialScale: saved.scale,
            initialRotation: saved.rotation,
            initialWarpAmount: saved.warpAmount,
            initialArcAmount: saved.arcAmount,
            initialOpacity: saved.opacity ?? 1,
            initialBlurAmount: saved.blurAmount ?? 0,
            initialBlendMode: saved.blendMode ?? "normal"
        };

        canvasData.push(data);

        const wrapper = document.createElement("div");
        wrapper.className = "canvas-wrapper";

        const canvasEl = document.createElement("canvas");

        wrapper.appendChild(canvasEl);

        const filenameInput = document.createElement("input");

        filenameInput.type = "text";
        filenameInput.className = "filename-input";
        filenameInput.value = saved.filename;

        filenameInput.addEventListener("input", e=>{
            data.filename = e.target.value;
        });

        wrapper.appendChild(filenameInput);

        container.appendChild(wrapper);

        const fabricCanvas = new fabric.Canvas(canvasEl,{
            preserveObjectStacking: true,
            selection: false,
            renderOnAddRemove: false
        });

        data.fabricCanvas = fabricCanvas;

        const realWidth = bgImg.width;

        const containerWidth = container.clientWidth;

        const targetColumnWidth =
            Math.min(420, (containerWidth - 100) / 4);

        const previewScale =
            Math.min(1, targetColumnWidth / realWidth);

        data.previewScale = previewScale;

        fabricCanvas.setWidth(bgImg.width * previewScale);
        fabricCanvas.setHeight(bgImg.height * previewScale);

        wrapper.style.width =
            (bgImg.width * previewScale) + "px";

        const bgFabric = await new Promise(resolve=>{

            fabric.Image.fromURL(saved.bgSrc, resolve,{
                crossOrigin:'anonymous'
            });
        });

        bgFabric.set({
            left:0,
            top:0,
            selectable:false,
            evented:false,
            originX:'left',
            originY:'top',
            scaleX:previewScale,
            scaleY:previewScale
        });

        fabricCanvas.add(bgFabric);

        // restore polygon overlay before rendering designs
        addClipOverlay(data);

        await applyWarpToData(data,false);
        await new Promise(r=>setTimeout(r,40));

        if(saved.duplicates?.length){

            for(const dup of saved.duplicates){

                await new Promise(resolve=>{

                    data.designObject.clone(cloned=>{

                        cloned.set({
                            left: dup.left,
                            top: dup.top,

                            scaleX:
                                dup.scaleX * previewScale,

                            scaleY:
                                dup.scaleY * previewScale,

                            angle: dup.angle,

                            opacity:
                                dup.opacity ?? data.opacity,

                            globalCompositeOperation:
                                dup.blendMode === 'multiply'
                                    ? 'multiply'
                                    : dup.blendMode === 'screen'
                                        ? 'screen'
                                        : 'source-over'
                        });

                        data.extraDesignObjects.push(cloned);

                        fabricCanvas.add(cloned);

                        attachFabricEvents(data, cloned);

                        resolve();
                    });
                });
            }
        }

        addClipOverlay(data);

                fabricCanvas.requestRenderAll();

        wrapper.addEventListener('click', function(e){

            if(suppressNextWrapperClick){
                return;
            }

            if(clipEditMode){
                return;
            }

                if(editMode === "design"){

                    if(index !== activeDesignWindow){
                        return;
                    }

                    activeIndices = [activeDesignWindow];

                    updateWindowBorders();
                    syncSliders();
                    updateSelectButtonState();

                    return;
                }

                const isModifierMultiSelect = e.metaKey || e.ctrlKey;

                // SHIFT = range select
                if(e.shiftKey){

                    if(lastSelectedIndex === null){

                        activeIndices = [index];

                    } else {

                        const start = Math.min(lastSelectedIndex, index);
                        const end = Math.max(lastSelectedIndex, index);

                        const range = [];

                        for(let i = start; i <= end; i++){
                            range.push(i);
                        }

                        activeIndices = [...new Set([
                            ...activeIndices,
                            ...range
                        ])];
                    }

                // CMD / CTRL = individual toggle select
                } else if(isModifierMultiSelect){

                    if(activeIndices.includes(index)){

                        activeIndices =
                            activeIndices.filter(i => i !== index);

                    } else {

                        activeIndices.push(index);
                    }

                    lastSelectedIndex = index;

                // normal click = single select
                } else {

                    activeIndices = [index];

                    lastSelectedIndex = index;
                }

                if(e.shiftKey){
                    lastSelectedIndex = index;
                }

                updateWindowBorders();

                syncSliders();
                updateSelectButtonState();
            });
            attachClipDrawing(
                wrapper,
                fabricCanvas,
                data,
                index
            );

    }

    loadingIndicator.innerText =
        "Session restored";

    setTimeout(()=>{
        loadingIndicator.style.display = "none";
    },800);
}


document.getElementById("loadProgressBtn").addEventListener("click", ()=>{

    if(clipEditMode){
        showClipModeNotice();
        return;
    }

    document.getElementById("loadProgressInput").click();
});

document.getElementById("loadProgressInput").addEventListener("change", function(event){

    const file = event.target.files[0];

    if(!file) return;

    const reader = new FileReader();

    reader.onload = async function(e){

        const snapshot = JSON.parse(e.target.result);

        await createCanvasPreviewsFromSnapshot(snapshot);

        syncSliders();
        updateWindowBorders();
    };

    reader.readAsText(file);
});


let resizeTimer;

window.addEventListener('resize', ()=>{

    clearTimeout(resizeTimer);

    resizeTimer = setTimeout(()=>{

        if(backgrounds.length){
            createCanvasPreviews();
        }

    }, 150);
});
