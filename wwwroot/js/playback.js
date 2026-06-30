import { S } from './state.js';

export function _pbApplyTime(t) {
    for (const tgt of S._pbTargets) {
        const { obj, is2D, sc2D, transKf, scaleKf, rotKf, orbitKf, startPos, startScale, startRot } = tgt;
        if (!obj || !startPos) continue;

        let ox = 0, oy = 0, oz = 0;
        if (transKf.length > 0) {
            for (const kf of transKf) {
                if (t < kf.time) break;
                const dur = kf.endTime - kf.time;
                if (dur <= 0) { ox += kf.x; oy += kf.y; oz += kf.z; continue; }
                const p = Math.min(1, (t - kf.time) / dur);
                ox += kf.x * p; oy += kf.y * p; oz += kf.z * p;
            }
        }

        if (orbitKf && orbitKf.length > 0) {
            for (const kf of orbitKf) {
                if (kf.radius === 0 || t < kf.time) continue;
                const dur = kf.endTime - kf.time;
                if (dur <= 0) continue;
                const p = Math.min(1, (t - kf.time) / dur);
                const angle = kf.degrees * Math.PI / 180 * p;
                ox += kf.radius * (Math.cos(angle) - 1);
                if (is2D)
                    oz += kf.radius * Math.sin(angle);
                else
                    oz += kf.radius * Math.sin(angle);
            }
        }

        if (transKf.length > 0 || (orbitKf && orbitKf.length > 0)) {
            if (is2D)
                obj.position.set(startPos.x + ox * sc2D, startPos.y + oz * sc2D, startPos.z);
            else
                obj.position.set(startPos.x + ox, startPos.y + oy, startPos.z + oz);
        }

        if (scaleKf.length > 0 && startScale) {
            let sx = 1, sy = 1, sz = 1;
            for (let i = 0; i < scaleKf.length; i++) {
                const kf = scaleKf[i];
                if (t < kf.time) break;
                const dur = kf.endTime - kf.time;
                if (dur <= 0) { sx = kf.x; sy = kf.y; sz = kf.z; continue; }
                const p = Math.min(1, (t - kf.time) / dur);
                const prev = i > 0 ? scaleKf[i - 1] : { x: 1, y: 1, z: 1 };
                sx = prev.x + (kf.x - prev.x) * p;
                sy = prev.y + (kf.y - prev.y) * p;
                sz = prev.z + (kf.z - prev.z) * p;
            }
            if (is2D)
                obj.scale.set(startScale.x * sx, startScale.y * sz, startScale.z);
            else
                obj.scale.set(startScale.x * sx, startScale.y * sy, startScale.z * sz);
        }

        if (rotKf.length > 0 && startRot) {
            let rx = 0, ry = 0, rz = 0;
            for (const kf of rotKf) {
                if (t < kf.time) break;
                const dur = kf.endTime - kf.time;
                if (dur <= 0) { rx += kf.x; ry += kf.y; rz += kf.z; continue; }
                const p = Math.min(1, (t - kf.time) / dur);
                rx += kf.x * p; ry += kf.y * p; rz += kf.z * p;
            }
            if (is2D)
                obj.rotation.set(0, 0, startRot.z + rx);
            else
                obj.rotation.set(startRot.x + rx, startRot.y + ry, startRot.z + rz);
        }
    }
    _tri3dApplyTime(t);
}

export function _tri3dApplyTime(t) {
    for (const mesh of S.tri3dMeshes) {
        const kfs = mesh.userData.tri3dKeyframes;
        if (!kfs || kfs.length < 2) continue;
        const vertCount = mesh.userData.tri3dVertCount;

        let kfA = kfs[0], kfB = kfs[0];
        for (let i = 0; i < kfs.length - 1; i++) {
            if (t >= kfs[i].time && t <= kfs[i + 1].time) {
                kfA = kfs[i]; kfB = kfs[i + 1]; break;
            }
            if (t > kfs[i + 1].time) { kfA = kfs[i + 1]; kfB = kfs[i + 1]; }
        }

        const dur = kfB.time - kfA.time;
        const p = dur > 0 ? Math.min(1, (t - kfA.time) / dur) : 0;
        const posAttr = mesh.geometry.getAttribute('position');
        const posA = kfA.positions, posB = kfB.positions;

        if (mesh.userData.is2D) {
            for (let i = 0; i < vertCount; i++) {
                const i3 = i * 3;
                const x = posA[i3]     + (posB[i3]     - posA[i3])     * p;
                const y = posA[i3 + 1] + (posB[i3 + 1] - posA[i3 + 1]) * p;
                posAttr.setXYZ(i, -x, y, 0);
            }
            posAttr.needsUpdate = true;
        } else {
            const initPos = mesh.userData.tri3dInitPos;
            let cx = 0, cy = 0, cz = 0;
            for (let i = 0; i < vertCount; i++) {
                const i3 = i * 3;
                const x = posA[i3]     + (posB[i3]     - posA[i3])     * p;
                const y = posA[i3 + 1] + (posB[i3 + 1] - posA[i3 + 1]) * p;
                const z = posA[i3 + 2] + (posB[i3 + 2] - posA[i3 + 2]) * p;
                cx += x; cy += y; cz += z;
                posAttr.setXYZ(i, x - initPos.x, y - initPos.y, z - initPos.z);
            }
            cx /= vertCount; cy /= vertCount; cz /= vertCount;
            mesh.position.set(cx, cy, cz);
            for (let i = 0; i < vertCount; i++) {
                posAttr.setXYZ(i, posAttr.getX(i) - cx + initPos.x, posAttr.getY(i) - cy + initPos.y, posAttr.getZ(i) - cz + initPos.z);
            }
            posAttr.needsUpdate = true;
            mesh.geometry.computeVertexNormals();
        }
    }
}

export function _tri3dMaxTime() {
    let d = 0;
    for (const mesh of S.tri3dMeshes) {
        const kfs = mesh.userData.tri3dKeyframes;
        if (kfs && kfs.length > 0) d = Math.max(d, kfs[kfs.length - 1].time);
    }
    return d;
}

export function _pbTotalDur() {
    let d = _tri3dMaxTime();
    for (const tgt of S._pbTargets) {
        if (tgt.transKf.length > 0) d = Math.max(d, tgt.transKf[tgt.transKf.length - 1].endTime);
        if (tgt.scaleKf.length > 0) d = Math.max(d, tgt.scaleKf[tgt.scaleKf.length - 1].endTime);
        if (tgt.rotKf.length > 0) d = Math.max(d, tgt.rotKf[tgt.rotKf.length - 1].endTime);
        if (tgt.orbitKf && tgt.orbitKf.length > 0) d = Math.max(d, tgt.orbitKf[tgt.orbitKf.length - 1].endTime);
    }
    return d;
}

export function _pbUpdateTimer(t) {
    const el = document.getElementById('playback-timer');
    if (!el) return;
    const total = Math.floor(t * 100);
    const cs = total % 100;
    const secs = Math.floor(total / 100) % 60;
    const mins = Math.floor(total / 6000);
    el.textContent = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0') + ':' + String(cs).padStart(2, '0');
}

export function _pbTick(ts) {
    if (!S._pbPlaying) return;
    if (S._pbLastTs === 0) { S._pbLastTs = ts; requestAnimationFrame(_pbTick); return; }
    const dt = (ts - S._pbLastTs) / 1000;
    S._pbLastTs = ts;
    S._pbTime += dt;
    const totalDur = _pbTotalDur();
    if (S._pbTime >= totalDur) {
        if (S._pbRepeat) {
            S._pbTime = 0;
        } else {
            S._pbTime = totalDur;
            S._pbPlaying = false;
        }
    }
    _pbApplyTime(S._pbTime);
    _pbUpdateTimer(S._pbTime);
    if (S._pbPlaying) requestAnimationFrame(_pbTick);
}

export function playbackStartAll(allAnims, repeat) {
    S._pbPlaying = false;
    if (S._pbTargets.length > 0 && S._pbTime > 0) {
        for (const tgt of S._pbTargets) {
            if (tgt.startPos) tgt.obj.position.copy(tgt.startPos);
            if (tgt.startScale) tgt.obj.scale.copy(tgt.startScale);
            if (tgt.startRot) tgt.obj.rotation.set(tgt.startRot.x, tgt.startRot.y, tgt.startRot.z);
        }
    }
    S._pbTargets = [];
    for (const a of (allAnims || [])) {
        let obj = null;
        let is2D = a.is2D;
        if (is2D) {
            const keys2d = [...S.importMeshGroups.keys()].filter(k => typeof k === 'string' && k.startsWith('2d_'));
            if (a.idx >= 0 && a.idx < keys2d.length)
                obj = S.importMeshGroups.get(keys2d[a.idx]);
        } else {
            const keys3d = [...S.importMeshGroups.keys()].filter(k => typeof k === 'number');
            if (a.idx >= 0 && a.idx < keys3d.length)
                obj = S.importMeshGroups.get(keys3d[a.idx]);
        }
        if (!obj && a.idx >= 0 && a.idx < S.tri3dMeshes.length) {
            obj = S.tri3dMeshes[a.idx];
            is2D = S._tri3dIs2D[a.idx] || false;
        }
        if (!obj) continue;
        S._pbTargets.push({
            obj,
            is2D,
            sc2D: obj.userData?._2dScale || 1,
            transKf: a.transKf || [],
            scaleKf: a.scaleKf || [],
            rotKf: a.rotKf || [],
            orbitKf: a.orbitKf || [],
            startPos: obj.position.clone(),
            startScale: obj.scale.clone(),
            startRot: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z }
        });
    }
    S._pbRepeat = repeat;
    S._pbTime = 0;
    S._pbLastTs = 0;
    S._pbPlaying = true;
    _pbUpdateTimer(0);
    requestAnimationFrame(_pbTick);
}

export function playbackPause() {
    S._pbPlaying = false;
}

export function playbackSeek(time) {
    S._pbTime = time;
    S._pbPlaying = false;
    if (time === 0) {
        for (const tgt of S._pbTargets) {
            if (tgt.startPos) tgt.obj.position.copy(tgt.startPos);
            if (tgt.startScale) tgt.obj.scale.copy(tgt.startScale);
            if (tgt.startRot) tgt.obj.rotation.set(tgt.startRot.x, tgt.startRot.y, tgt.startRot.z);
        }
        _tri3dApplyTime(0);
    }
    _pbApplyTime(S._pbTime);
    _pbUpdateTimer(S._pbTime);
}
