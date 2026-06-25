'use strict';
function clearBezierHelpers(canvas){

    activeBezierHelpers.forEach(obj=>{

        if(canvas.getObjects().includes(obj)){
            canvas.remove(obj);
        }
    });

    activeBezierHelpers = [];

    // IMPORTANT:
    // remove ONLY temporary editor helper objects.
    // keep finalized clipping overlays visible
    // while drawing additional polygons.
    canvas.getObjects()
        .filter(obj=>
            obj.excludeFromExport &&
            (
                obj.isBezierHelper ||
                obj.isRubberBand   ||
                // Only remove marching-ants paths that are temporary
                // (live editor preview). Finalized overlays have
                // isTempCurvePreview === false and must stay visible.
                ((obj.isMarchingDark || obj.isMarchingLight || obj.isTempCurvePreview) &&
                  obj.isTempCurvePreview)
            )
        )
        .forEach(obj=>{
            canvas.remove(obj);
        });
}


function drawBezierHelpers(canvas, points){

    clearBezierHelpers(canvas);

    if(points.length >= 2){

        for(let i = 0; i < points.length - 1; i++){

            const p1 = points[i];
            const p2 = points[i + 1];

            // only show straight helper edge
            // if this segment has not been curved yet
            if(
                p1.cx === undefined ||
                p1.cy === undefined
            ){

                const line = new fabric.Line(
                    [p1.x, p1.y, p2.x, p2.y],
                    {
                        stroke:'rgba(180,180,180,0.5)',
                        strokeWidth:0.5,
                        selectable:false,
                        evented:false,
                        excludeFromExport:true,
                        isBezierHelper:true
                    }
                );

                canvas.add(line);
                activeBezierHelpers.push(line);
            }
        }
    }

    points.forEach((point,index)=>{

        const anchor = new fabric.Circle({
            left: point.x,
            top: point.y,
            radius: 2.2,
            fill: 'rgba(230,230,230,0.85)',
            stroke:'rgba(80,80,80,0.7)',
            strokeWidth:0.5,
            originX:'center',
            originY:'center',
            selectable:false,
            evented:false,
            excludeFromExport:true,
            isBezierHelper:true
        });

        canvas.add(anchor);
        activeBezierHelpers.push(anchor);

        const handleLength = 10;

        const leftHandleX = point.x - handleLength;

        const rightHandleX =
            point.cx !== undefined
                ? point.cx
                : point.x + handleLength;

        const leftLine = new fabric.Line(
            [point.x, point.y, leftHandleX, point.y],
            {
                stroke:'rgba(180,180,180,0.35)',
                strokeWidth:0.4,
                selectable:false,
                evented:false,
                excludeFromExport:true,
                isBezierHelper:true
            }
        );

        const rightLine = new fabric.Line(
            [
                point.x,
                point.y,
                rightHandleX,
                point.cy !== undefined
                    ? point.cy
                    : point.y
            ],
            {
                stroke:'rgba(180,180,180,0.5)',
                strokeWidth:0.4,
                selectable:false,
                evented:false,
                excludeFromExport:true,
                isBezierHelper:true
            }
        );

        canvas.add(leftLine);
        canvas.add(rightLine);

        activeBezierHelpers.push(leftLine);
        activeBezierHelpers.push(rightLine);

        const rightHandle = new fabric.Circle({
            left: rightHandleX,
            top:
                point.cy !== undefined
                    ? point.cy
                    : point.y,
            radius:1.4,
            fill:'rgba(255,255,255,0.7)',
            stroke:'rgba(140,140,140,0.7)',
            strokeWidth:0.5,
            originX:'center',
            originY:'center',
            selectable:false,
            evented:false,
            excludeFromExport:true,
            isBezierHelper:true
        });

        rightHandle.pointIndex = index;
        rightHandle.isBezierHandle = true;

        canvas.add(rightHandle);
        activeBezierHelpers.push(rightHandle);
    });
}


// Draws dimmed anchor nodes + curvature handles for every finalized maskPath
// that is NOT the one currently being edited (currentMaskIndex / active clipCurvePoints).
// Called after drawBezierHelpers so their bring-to-front ordering is maintained.
function drawInactivePaths(canvas, data){

    const paths = data.maskPaths || [];

    paths.forEach((path, pathIdx) => {

        // skip the path currently loaded into the editor
        if(
            clipPolygonClosed &&
            currentMaskIndex !== undefined &&
            pathIdx === currentMaskIndex
        ) return;

        if(!path || !path.length) return;

        path.forEach((point, ptIdx) => {

            // anchor dot — blue-tinted to distinguish from active path (white)
            const anchor = new fabric.Circle({
                left:           point.x,
                top:            point.y,
                radius:         2.5,
                fill:           'rgba(140,165,255,0.65)',
                stroke:         'rgba(70,100,210,0.55)',
                strokeWidth:    0.5,
                originX:        'center',
                originY:        'center',
                selectable:     false,
                evented:        false,
                excludeFromExport: true,
                isBezierHelper: true,
                isInactiveClipHelper: true,
                isInactiveAnchor:    true,
                inactivePathIndex:   pathIdx,
                inactivePointIndex:  ptIdx
            });

            canvas.add(anchor);
            activeBezierHelpers.push(anchor);

            // curvature handle + tether line (when curve control exists)
            if(point.cx !== undefined && point.cy !== undefined){

                const line = new fabric.Line(
                    [point.x, point.y, point.cx, point.cy],
                    {
                        stroke:         'rgba(120,145,235,0.35)',
                        strokeWidth:    0.5,
                        selectable:     false,
                        evented:        false,
                        excludeFromExport: true,
                        isBezierHelper: true,
                        isInactiveClipHelper: true
                    }
                );
                canvas.add(line);
                activeBezierHelpers.push(line);

                const handle = new fabric.Circle({
                    left:           point.cx,
                    top:            point.cy,
                    radius:         1.6,
                    fill:           'rgba(185,200,255,0.6)',
                    stroke:         'rgba(90,115,215,0.5)',
                    strokeWidth:    0.4,
                    originX:        'center',
                    originY:        'center',
                    selectable:     false,
                    evented:        false,
                    excludeFromExport: true,
                    isBezierHelper: true,
                    isInactiveClipHelper: true
                });
                canvas.add(handle);
                activeBezierHelpers.push(handle);
            }
        });
    });
}


function buildCurvePathString(points, closed = true){

    if(!points.length){
        return "";
    }

    let path = `M ${points[0].x} ${points[0].y}`;

    for(let i = 1; i < points.length; i++){

        const prev = points[i - 1];
        const current = points[i];

        // straight line by default
        if(
            prev.cx === undefined ||
            prev.cy === undefined
        ){

            path += ` L ${current.x} ${current.y}`;

        } else {

            path += ` Q ${prev.cx} ${prev.cy} ${current.x} ${current.y}`;
        }
    }

    if(closed && points.length >= 3){

        const last = points[points.length - 1];
        const first = points[0];

        if(
            last.cx === undefined ||
            last.cy === undefined
        ){

            path += ` L ${first.x} ${first.y} Z`;

        } else {

            path += ` Q ${last.cx} ${last.cy} ${first.x} ${first.y} Z`;
        }
    }

    return path;
}

// Returns [darkPath, lightPath] — two overlapping dashed paths that together
// create Photoshop polygon-lasso "marching ants": black and white dashes
// interleaved so the outline is visible on any background colour.
// The animation loop (startMarchingAnts) scrolls strokeDashOffset over time.
function createCurveOverlay(
    points,
    closed = false,
    isTemporary = true
){
    const pathStr = buildCurvePathString(points, closed);

    const common = {
        fill:             'rgba(0,0,0,0)',
        strokeWidth:      1,
        strokeDashArray:  [4, 4],
        selectable:       false,
        evented:          false,
        excludeFromExport:true,
        isTempCurvePreview: isTemporary,
        objectCaching:    false
    };

    // dark layer — black dashes
    const dark = new fabric.Path(pathStr, {
        ...common,
        stroke:           'rgba(0,0,0,0.85)',
        strokeDashOffset: _marchingAntsOffset,
        isMarchingDark:   true
    });

    // light layer — white dashes, offset by half the dash cycle so they
    // fill the gaps left by the dark dashes
    const light = new fabric.Path(pathStr, {
        ...common,
        stroke:           'rgba(255,255,255,0.92)',
        strokeDashOffset: (_marchingAntsOffset + 4) % 8,
        isMarchingLight:  true
    });

    return [dark, light];
}


function startMarchingAnts(){
    if(_marchingAntsTimer) return;

    _marchingAntsTimer = setInterval(()=>{

        _marchingAntsOffset = (_marchingAntsOffset + 1) % 8;

        canvasData.forEach(data=>{
            if(!data.fabricCanvas) return;

            let dirty = false;

            data.fabricCanvas.getObjects().forEach(obj=>{

                if(obj.isMarchingDark){
                    obj.strokeDashOffset = _marchingAntsOffset;
                    dirty = true;
                }

                if(obj.isMarchingLight){
                    obj.strokeDashOffset = (_marchingAntsOffset + 4) % 8;
                    dirty = true;
                }
            });

            if(dirty) data.fabricCanvas.requestRenderAll();
        });

    }, 80);
}


function stopMarchingAnts(){
    if(_marchingAntsTimer){
        clearInterval(_marchingAntsTimer);
        _marchingAntsTimer = null;
    }
}



function applyClipMaskToObject(obj, data){

    if(!obj) return;

    if(
        data.maskEnabled &&
        data.maskPath &&
        data.maskType === "bezier"
    ){

        const paths = (data.maskPaths || [data.maskPath])
            .filter(Boolean)
            .map(points=>
                new fabric.Path(
                    buildCurvePathString(points, true),
                    {
                        absolutePositioned:true,
                        originX:'left',
                        originY:'top'
                    }
                )
            );

        obj.clipPath = new fabric.Group(paths,{
            absolutePositioned:true
        });

    } else {

        obj.clipPath = null;
    }
}





function addClipOverlay(data){

    if(data.clipOverlays){

        data.clipOverlays.forEach(overlay=>{
            data.fabricCanvas.remove(overlay);
        });
    }

    data.clipOverlays = [];

    if(
        !data.maskEnabled ||
        data.maskType !== "bezier"
    ){
        return;
    }

    const allMasks =
        data.maskPaths?.length
            ? data.maskPaths
            : (data.maskPath ? [data.maskPath] : []);

    if(!allMasks.length){
        return;
    }

    // restore editor state using latest polygon only
    const latestMask =
        allMasks[allMasks.length - 1];

    data.clipCurvePoints = JSON.parse(
        JSON.stringify(latestMask)
    );

    data.clipPolygonClosed = true;

    allMasks.forEach(path=>{

        const overlays =
            createCurveOverlay(
                path,
                true,
                false
            );

        overlays.forEach(o=>{
            data.clipOverlays.push(o);
            data.fabricCanvas.add(o);
            o.bringToFront();
        });
    });

    if(data.designObject){
        data.designObject.bringToFront();
    }
}




// Creates a default _fx settings bag from the window-level data object.
// Used to initialise a design object's per-object effects on first use.
