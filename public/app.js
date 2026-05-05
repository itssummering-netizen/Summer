(function () {
    'use strict';
    let files = [], groups = [], currentGroupId = 'default', currentSort = 'default';
    let hiddenMode = false, currentFolderId = null, folderStack = [], contextTarget = null, dragState = null;
    let viewerFilesList = [], viewerIndex = 0, currentViewerFile = null;
    let isAuth = false;
    let panState = { active: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0 };
    let isSpaceDown = false, panX = window.innerWidth / 2, panY = window.innerHeight / 2, scale = 1.0;
    let isLoadingUser = false;
    /** Khi true: không cho đóng popup auth (chỉ dùng khi cần giữ popup mở tạm thời) */
    let suppressDismissUntilLibraryShown = false;
    /** Gợi ý số card trong lần render hiện tại — giảm animation khi danh sách dài */
    let renderCardCountHint = 0;
    let thumbIntersectionObserver = null;

    const $ = id => document.getElementById(id);
    const viewport = $('canvas'), canvas = $('canvasContent'), emptyState = $('emptyState'), ctxCanvas = $('ctxCanvas'), ctxFile = $('ctxFile');
    const ctxGroup = $('ctxGroup'), viewerOverlay = $('viewerOverlay'), viewerPopup = $('viewerPopup');
    const viewerTitle = $('viewerTitle'), viewerBody = $('viewerBody'), viewerClose = $('viewerClose');
    const viewerTime = $('viewerTime'), viewerToolbar = $('viewerToolbar');
    const viewerPrev = $('viewerPrev'), viewerNext = $('viewerNext');
    const hiddenBanner = $('hiddenBanner'), btnBack = $('btnBack'), btnSort = $('btnSort');
    const sortDropdown = $('sortDropdown'), fileInput = $('fileInput');
    const btnGroup = $('btnGroup'), groupPopup = $('groupPopup'), groupList = $('groupList');
    const btnAddGroup = $('btnAddGroup'), groupNameEl = $('groupName');
    const folderNav = $('folderNav'), navBack = $('navBack'), navPath = $('navPath');
    const authFlowPopup = $('authFlowPopup'), userAccPopup = $('userAccPopup'), authVerifying = $('authVerifying');

    function setAuthVerifying(on) {
        const v = !!on;
        if (authVerifying) {
            authVerifying.classList.toggle('is-active', v);
            authVerifying.setAttribute('aria-hidden', v ? 'false' : 'true');
        }
        if (authFlowPopup) authFlowPopup.classList.toggle('auth-flow-popup--verifying', v);
    }

    function resetAuthFlowUi() {
        setAuthVerifying(false);
        const s1 = $('authStep1'), s2 = $('authStep2'), s3 = $('authStep3');
        if (s1) s1.style.display = 'block';
        if (s2) s2.style.display = 'none';
        if (s3) s3.style.display = 'none';
        const b1 = $('authNext1'), b2 = $('authNext2');
        if (b1) b1.classList.remove('loading');
        if (b2) b2.classList.remove('loading');
        const oc = $('otpContainer');
        if (oc) Array.from(oc.children).forEach((inp) => { inp.value = ''; });
    }

    const ICONS = {
        folder: `<img class="folder-icon" src="/icons/folder.png" alt="folder" draggable="false">`,
        file: `<img class="file-icon" src="/icons/file.png" alt="file" draggable="false">`
    };

    /** Đổi khi Drive/meta cập nhật → ép trình duyệt tải lại thumb/raw, khớp kho Drive */
    function fileMediaRevision(f) {
        return encodeURIComponent([f.driveFileId || '', f.driveThumbnailId || '', f.size || 0, f.uploadedAt || '', f.name || ''].join('|'));
    }
    function thumbUrl(f) {
        if (f.localThumbUrl) return f.localThumbUrl;
        return `/api/files/${f.id}/thumbnail?v=${fileMediaRevision(f)}`;
    }
    function rawUrl(f) {
        return `/api/files/${f.id}/raw?v=${fileMediaRevision(f)}`;
    }



    let driveMetaRefreshTimers = [];
    function clearDriveMetaRefreshTimers() {
        driveMetaRefreshTimers.forEach(clearTimeout);
        driveMetaRefreshTimers = [];
    }
    /** Sau login / enrich Drive, vài lần refetch nhẹ để thumb & meta khớp kho — không giật vì giữ position */
    function scheduleDriveMetaRefresh() {
        if (!isAuth) return;
        clearDriveMetaRefreshTimers();
        [900, 2800, 6500].forEach((ms) => {
            driveMetaRefreshTimers.push(setTimeout(async () => {
                try {
                    const r = await fetch(`/api/files?groupId=${currentGroupId}`, { cache: 'no-store' });
                    if (!r.ok) return;
                    const data = await r.json();
                    applyServerFiles(data);
                    saveToCache();
                    render();
                } catch (e) { }
            }, ms));
        });
    }

    function ensureThumbObserver() {
        if (thumbIntersectionObserver || !('IntersectionObserver' in window)) return thumbIntersectionObserver;
        thumbIntersectionObserver = new IntersectionObserver((entries) => {
            for (const en of entries) {
                if (!en.isIntersecting) continue;
                const img = en.target;
                const url = img.dataset.thumbSrc;
                if (url && img.getAttribute('src') !== url) img.src = url;
                thumbIntersectionObserver.unobserve(img);
            }
        }, { root: null, rootMargin: '200px', threshold: 0 });
        return thumbIntersectionObserver;
    }

    /** Chờ browser vẽ một frame (sau khi DOM đã có tên file trên card) */
    function waitNextPaint() {
        return new Promise((resolve) => {
            requestAnimationFrame(() => {
                requestAnimationFrame(resolve);
            });
        });
    }

    function dismissLoginAfterCanvasPaint() {
        setAuthVerifying(false);
        if (authFlowPopup) authFlowPopup.style.display = 'none';
        suppressDismissUntilLibraryShown = false;
    }

    /** Sau login: đồng bộ danh sách; đóng popup ngay sau khi canvas đã render tên file (chưa cần thumb xong) */
    async function syncFilesAfterLogin() {
        setAuthVerifying(true);
        suppressDismissUntilLibraryShown = true;
        
        let success = false;
        for (let attempt = 0; attempt < 40; attempt++) {
            try {
                const fRes = await fetch(`/api/files?groupId=${currentGroupId}`, { cache: 'no-store' });
                if (fRes.ok) {
                    const data = await fRes.json();
                    if (Array.isArray(data)) {
                        applyServerFiles(data);
                        saveToCache();
                        
                        // 1. Tính toán vị trí tâm ngay lập tức (Chưa render) với scale = 0.5 (zoom out)
                        scale = 0.5;
                        document.documentElement.style.setProperty('--card-scale', scale);
                        focusContent({ smooth: false });
                        
                        // 2. Sau khi camera đã ở đúng vị trí, mới vẽ file
                        render();
                        
                        // 3. Đóng popup và thực hiện hiệu ứng lướt mượt mà về scale mặc định (1.0)
                        dismissLoginAfterCanvasPaint();
                        
                        setTimeout(() => {
                            scale = 1.0;
                            document.documentElement.style.setProperty('--card-scale', scale);
                            focusContent({ smooth: true });
                        }, 50);
                        
                        if (isAuth) scheduleDriveMetaRefresh();
                        success = true;
                        break;
                    }
                }
            } catch (e) { console.error('syncFilesAfterLogin:', e); }
            await new Promise((r) => setTimeout(r, 400));
        }
        
        if (!success) {
            isLoadingUser = false;
            render();
            dismissLoginAfterCanvasPaint();
            focusContent({ smooth: true });
        }
    }

    function saveToCache() {
        localStorage.setItem(`storage_files_${currentGroupId}`, JSON.stringify(files));
    }
    function loadFromCache() {
        const cached = localStorage.getItem(`storage_files_${currentGroupId}`);
        if (cached) {
            files = JSON.parse(cached);
            render();
        }
    }

    function fmtDate(iso) {
        const d = new Date(iso);
        const date = d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const time = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        return `${date} ${time}`;
    }

    /**
     * @param {{ skipFilesFetch?: boolean }} [options] — sau OTP: bỏ qua GET /api/files ở đây, gọi syncFilesAfterLogin riêng
     */
    async function init(options = {}) {
        const skipFilesFetch = !!options.skipFilesFetch;
        const dt = $('dateText');
        if (dt) { const now = new Date(); dt.textContent = now.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }); }

        isLoadingUser = true; // Bật loading ngay từ đầu để tránh hiện Empty State nhầm
        render();

        try {
            const authRes = await (await fetch('/auth/status', { cache: 'no-store' })).json();
            isAuth = authRes.authenticated;

            const btnAuth = $('btnAuth');
            if (isAuth && authRes.user) {
                const av = authRes.user.avatar || '☁️';
                if (av.startsWith('http') || av.startsWith('/') || av.startsWith('data:')) {
                    $('authAvatar').style.display = 'inline-block';
                    $('authAvatar').src = av;
                    $('authIconLogin').style.display = 'none';
                } else {
                    const avBtn = document.querySelector(`.avatar-option[data-avatar="${av}"]`);
                    if (avBtn) {
                        $('authIconLogin').style.display = 'none';
                        $('authAvatar').style.display = 'none';
                        const svgClone = avBtn.querySelector('svg');
                        if (svgClone) { btnAuth.innerHTML = ''; btnAuth.appendChild(svgClone.cloneNode(true)); }
                        else { btnAuth.innerHTML = `<span style="font-size:18px;">${av}</span>`; }
                    }
                }
                $('userAccName').value = authRes.user.name || authRes.user.email.split('@')[0];
                const curBtn = document.querySelector(`.avatar-option[data-avatar="${av}"]`);
                if (curBtn) {
                    $('userAvatarCurrent').innerHTML = '';
                    const svg = curBtn.querySelector('svg');
                    if (svg) $('userAvatarCurrent').appendChild(svg.cloneNode(true));
                    else $('userAvatarCurrent').innerHTML = `<span style="font-size:32px;">${av}</span>`;
                }

                btnAuth.onclick = (e) => { e.stopPropagation(); const isVisible = userAccPopup.style.display === 'block'; hideAllMenus(); userAccPopup.style.display = isVisible ? 'none' : 'block'; };
                
                $('userLogoutBtn').onclick = async () => { 
                    clearDriveMetaRefreshTimers(); 
                    await fetch('/auth/logout', { method: 'POST', cache: 'no-store' }); 
                    localStorage.removeItem(`storage_files_${currentGroupId}`); 
                    location.reload(); 
                };

                let nameTimeout;
                $('userAccName').oninput = e => {
                    clearTimeout(nameTimeout);
                    nameTimeout = setTimeout(async () => {
                        await fetch('/api/user/name', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: e.target.value }) });
                    }, 500);
                };

                $('avatarGrid').onclick = async e => {
                    const btn = e.target.closest('[data-avatar]');
                    if (!btn) return;
                    const avatarId = btn.dataset.avatar;
                    const svg = btn.querySelector('svg');
                    $('userAvatarCurrent').innerHTML = ''; btnAuth.innerHTML = '';
                    if (svg) {
                        $('userAvatarCurrent').appendChild(svg.cloneNode(true));
                        btnAuth.appendChild(svg.cloneNode(true));
                    } else {
                        $('userAvatarCurrent').innerHTML = `<span style="font-size:32px;">${avatarId}</span>`;
                        btnAuth.innerHTML = `<span style="font-size:18px;">${avatarId}</span>`;
                    }
                    $('authAvatar').style.display = 'none';
                    await fetch('/api/user/avatar', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar: avatarId }) });
                };

                $('avatarUploadBtn').onclick = () => $('avatarInput').click();
                $('avatarInput').onchange = async (e) => {
                    const file = e.target.files[0]; if (!file) return;
                    const reader = new FileReader();
                    reader.onload = async (ev) => {
                        const img = new Image(); img.onload = async () => {
                            const s = Math.min(img.width, img.height);
                            const cx = (img.width - s) / 2, cy = (img.height - s) / 2;
                            const c = document.createElement('canvas'); c.width = 64; c.height = 64;
                            c.getContext('2d').drawImage(img, cx, cy, s, s, 0, 0, 64, 64);
                            const dataUrl = c.toDataURL('image/webp', 0.8);
                            $('authAvatar').src = dataUrl; $('authAvatar').style.display = 'inline-block';
                            btnAuth.innerHTML = ''; btnAuth.appendChild($('authAvatar').cloneNode(true));
                            $('userAvatarCurrent').innerHTML = `<img src="${dataUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
                            await fetch('/api/user/avatar', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar: dataUrl }) });
                        }; img.src = ev.target.result;
                    }; reader.readAsDataURL(file);
                };
            } else {
                $('authAvatar').style.display = 'none';
                $('authIconLogin').style.display = 'inline-block';
                btnAuth.onclick = (e) => { e.stopPropagation(); const isVisible = authFlowPopup.style.display === 'block'; hideAllMenus(); if (!isVisible) { resetAuthFlowUi(); authFlowPopup.style.display = 'block'; setTimeout(() => $('authEmail').focus(), 50); } };
            }
        } catch (e) { console.error('Auth check failed:', e); }

        try {
            const grRes = await fetch('/api/groups', { cache: 'no-store' });
            if (grRes.ok) {
                groups = await grRes.json();
                if (groups.length) { currentGroupId = groups[0].id; groupNameEl.textContent = groups[0].name; }
            }
        } catch (e) { console.error('Groups fetch failed:', e); }

        loadFromCache();
        
        // Mặc định: Đưa tâm màn hình nhìn thẳng vào gốc tọa độ (0, 0)
        panX = window.innerWidth / 2;
        panY = window.innerHeight / 2;
        updateTransform(false);
        render();

        if (!skipFilesFetch) {
            try {
                const filesRes = await fetch(`/api/files?groupId=${currentGroupId}`, { cache: 'no-store' });
                if (filesRes.ok) {
                    const data = await filesRes.json();
                    applyServerFiles(data);
                    saveToCache();
                    // Căn giữa lại dựa trên thực tế cụm file vừa tải (Tính trước khi render)
                    focusContent({ smooth: false });
                    render();
                }
            } catch (e) { console.error('Files fetch failed:', e); }
        }

        isLoadingUser = false;
        render();
        requestAnimationFrame(() => {
            focusContent({ smooth: false });
        });

        if (isAuth && !skipFilesFetch) scheduleDriveMetaRefresh();
        if (!window.eventsBound) { bindEvents(); window.eventsBound = true; }
    }

    function updateTransform(smooth = false) {
        // Đảm bảo không bao giờ bị NaN khiến canvas biến mất
        if (isNaN(panX) || !isFinite(panX)) panX = window.innerWidth / 2;
        if (isNaN(panY) || !isFinite(panY)) panY = window.innerHeight / 2;
        
        canvas.style.transition = smooth ? 'transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)' : 'none';
        canvas.style.transform = `translate(${panX}px, ${panY}px)`;
    }

    function updateScale(delta) {
        scale = Math.max(0.4, Math.min(1.4, scale + delta));
        document.documentElement.style.setProperty('--card-scale', scale);
    }

    /** Kích thước ô thẻ (đồng bộ findFreePosition / CSS) — bbox, bán kính cụm… */
    function cardOuterSize() {
        return { w: 156 * scale, h: 200 * scale };
    }

    /** Điểm đại diện khi tính cụm / pan: đúng vị trí lưu của card (`left`/`top` trên canvas) */
    function fileClusterPoint(f) {
        if (!f.position) return { id: f.id, x: 0, y: 0 };
        return { id: f.id, x: f.position.x, y: f.position.y };
    }

    function clusterBBoxArea(cluster) {
        if (cluster.length === 0) return 0;
        const xx = cluster.map((p) => p.x), yy = cluster.map((p) => p.y);
        return (Math.max(...xx) - Math.min(...xx)) * (Math.max(...yy) - Math.min(...yy));
    }

    /** Đồ thị: cạnh nếu khoảng cách anchor ≤ R — trả về cụm có nhiều đỉnh nhất (hòa: bbox nhỏ hơn). */
    function largestClusterAtRadius(pts, R) {
        const n = pts.length;
        const parent = new Int32Array(n);
        for (let i = 0; i < n; i++) parent[i] = i;
        function find(a) {
            let r = a;
            while (parent[r] !== r) r = parent[r];
            let x = a;
            while (parent[x] !== x) {
                const nxt = parent[x];
                parent[x] = r;
                x = nxt;
            }
            return r;
        }
        function union(a, b) {
            const ra = find(a), rb = find(b);
            if (ra !== rb) parent[ra] = rb;
        }
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) <= R) union(i, j);
            }
        }
        const byRoot = new Map();
        for (let i = 0; i < n; i++) {
            const r = find(i);
            if (!byRoot.has(r)) byRoot.set(r, []);
            byRoot.get(r).push(pts[i]);
        }
        let best = [pts[0]];
        for (const c of byRoot.values()) {
            if (c.length > best.length) best = c;
            else if (c.length === best.length && clusterBBoxArea(c) < clusterBBoxArea(best)) best = c;
        }
        return best;
    }

    /**
     * Tập trung màn hình vào nội dung.
     * @param {Object} opts
     * @param {boolean} [opts.smooth=true] - Di chuyển mượt
     * @param {boolean} [opts.fit=false] - Tự động thay đổi scale để vừa khít các file
     * @param {number} [opts.padding=60] - Khoảng cách đệm khi fit
     */
    function focusContent(opts = {}) {
        const { smooth = true, fit = false, padding = 60 } = opts;
        const vf = getVisibleFiles();
        const validFiles = vf.filter(f => f && f.position && typeof f.position.x === 'number');

        if (validFiles.length === 0) {
            panX = Math.round(window.innerWidth / 2);
            panY = Math.round(window.innerHeight / 2);
            updateTransform(smooth);
            return;
        }

        const cw = window.innerWidth, ch = window.innerHeight;
        
        // 1. Tìm vùng bao (Bounding Box) của hệ ĐIỂM NEO {x, y}
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        
        validFiles.forEach(f => {
            const x = Number(f.position.x);
            const y = Number(f.position.y);
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        });

        // 2. Tính toán Scale dựa trên độ trải rộng của các điểm neo
        if (fit) {
            const spreadX = maxX - minX;
            const spreadY = maxY - minY;
            // Padding lớn để bao quát cả diện tích Card dù chỉ tính theo điểm
            const targetScale = Math.min(1.2, Math.max(0.4, Math.min(cw / (spreadX + padding * 2), ch / (spreadY + padding * 2))));
            
            scale = targetScale;
            document.documentElement.style.setProperty('--card-scale', scale);
        }

        // 3. Tâm màn hình là trung điểm hình học của hệ điểm neo (có bù trừ -80px cho cân đối)
        const centerX = (minX + maxX) / 2;
        const centerY = ((minY + maxY) / 2) - 80;

        panX = Math.round(cw / 2 - centerX);
        panY = Math.round(ch / 2 - centerY);

        updateTransform(smooth);
    }

    function centerDefaultFiles() {
        focusContent({ smooth: false });
    }

    let resizeTimeout;
    window.addEventListener('resize', () => {
        cancelAnimationFrame(resizeTimeout);
        resizeTimeout = requestAnimationFrame(() => {
            if (!isAuth) centerDefaultFiles();
        });
    });

    function resetAuthFlowUi() {
        $('authEmail').value = '';
        if ($('authName')) $('authName').value = '';
        otpInputs.forEach(x => x.value = '');
        $('authStep1').style.display = 'block';
        $('authStep2').style.display = 'none';
        $('authStep3').style.display = 'none';
        setAuthVerifying(false);
    }

    function setAuthVerifying(v) {
        const overlay = $('authVerifying');
        if (overlay) overlay.style.display = v ? 'flex' : 'none';
    }

    function requireLogin() {
        if (!isAuth) {
            resetAuthFlowUi();
            authFlowPopup.style.display = 'block';
            $('authEmail').focus();
            return false;
        }
        return true;
    }

    let tempEmail = '', isNewUser = false;
    async function requestOtp(payload) {
        const resp = await fetch('/auth/request-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.ok) {
            throw new Error(data.error || 'Failed to send OTP');
        }
        return data;
    }

    $('authNext1').onclick = async () => {
        const email = $('authEmail').value.trim();
        if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
            $('authEmail').classList.add('error');
            setTimeout(() => $('authEmail').classList.remove('error'), 2000);
            return;
        }
        tempEmail = email;
        const b1 = $('authNext1'); b1.classList.add('loading');
        try {
            const checkResp = await fetch('/auth/check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: tempEmail })
            });
            const checkData = await checkResp.json().catch(() => ({}));
            if (!checkResp.ok) throw new Error(checkData.error || 'Cannot verify account');
            isNewUser = !!checkData.isNew;
            if (isNewUser) {
                b1.classList.remove('loading');
                $('authStep1').style.display = 'none';
                $('authStep2').style.display = 'block';
            } else {
                await requestOtp({ email: tempEmail });
                b1.classList.remove('loading');
                $('authStep1').style.display = 'none';
                $('authStep3').style.display = 'block';
                $('otpContainer').children[0].focus();
            }
        } catch (err) {
            b1.classList.remove('loading');
            alert(err.message || 'Bước kiểm tra email thất bại. Vui lòng thử lại.');
        }
    };
    $('authNext2').onclick = async () => {
        const name = $('authName').value.trim();
        const b2 = $('authNext2'); b2.classList.add('loading');
        try {
            await requestOtp({ email: tempEmail, name });
            b2.classList.remove('loading');
            $('authStep2').style.display = 'none';
            $('authStep3').style.display = 'block';
            $('otpContainer').children[0].focus();
        } catch (err) {
            b2.classList.remove('loading');
            alert(err.message || 'Không gửi được mã OTP. Vui lòng thử lại.');
        }
    };

    const otpInputs = Array.from($('otpContainer').children);

    $('otpContainer').addEventListener('paste', e => {
        e.preventDefault();
        const pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
        if (!pasted) return;
        for (let i = 0; i < pasted.length; i++) {
            if (otpInputs[i]) otpInputs[i].value = pasted[i];
        }
        const nextIdx = Math.min(pasted.length, 5);
        otpInputs[nextIdx].focus();
        if (pasted.length === 6) verifyOtp();
    });

    otpInputs.forEach((inp, i) => {
        inp.addEventListener('input', e => {
            if (e.target.value && i < otpInputs.length - 1) otpInputs[i + 1].focus();
            if (otpInputs.every(x => x.value)) verifyOtp();
        });
        inp.addEventListener('keydown', e => {
            if (e.key === 'Backspace' && !e.target.value && i > 0) otpInputs[i - 1].focus();
        });
    });

    function customConfirm(msg, onOk) {
        const modal = $('confirmModal');
        $('confirmMessage').textContent = msg;
        modal.style.display = 'flex';
        const okBtn = $('confirmOk'), cancelBtn = $('confirmCancel');
        const cleanup = () => {
            modal.style.display = 'none';
            okBtn.onclick = null;
            cancelBtn.onclick = null;
        };
        okBtn.onclick = () => { cleanup(); onOk(); };
        cancelBtn.onclick = () => { cleanup(); };
    }

    function startGroupRename() {
        if (!isAuth) return;
        const g = groups.find(g => g.id === currentGroupId); if (!g) return;

        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'group-name-input';
        inp.value = g.name;

        const updateWidth = () => {
            const span = document.createElement('span');
            span.style.visibility = 'hidden';
            span.style.position = 'absolute';
            span.style.whiteSpace = 'pre';
            span.style.font = window.getComputedStyle(inp).font;
            span.textContent = inp.value || inp.placeholder || ' ';
            document.body.appendChild(span);
            inp.style.width = span.offsetWidth + 'px';
            document.body.removeChild(span);
        };

        const target = $('groupName');
        const initialWidth = target.offsetWidth;
        target.replaceWith(inp);
        inp.style.width = initialWidth + 'px';
        inp.focus();
        // Do NOT select all text as requested
        inp.setSelectionRange(inp.value.length, inp.value.length);

        inp.addEventListener('input', updateWidth);

        const fin = async () => {
            const v = inp.value.trim() || g.name;
            if (v !== g.name) {
                await fetch(`/api/groups/${g.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: v }) });
                g.name = v;
            }
            target.textContent = g.name;
            inp.replaceWith(target);
        };

        inp.addEventListener('blur', fin);
        inp.addEventListener('keydown', e => {
            if (e.key === 'Enter') inp.blur();
            if (e.key === 'Escape') { inp.value = g.name; inp.blur(); }
        });
    }

    let verifyOtpInFlight = false;
    async function verifyOtp() {
        const otp = otpInputs.map(x => x.value).join('');
        if (otp.length !== 6) return;
        if (verifyOtpInFlight) return;
        verifyOtpInFlight = true;
        setAuthVerifying(true);
        authFlowPopup.style.display = 'block';
        let res;
        try {
            res = await (await fetch('/auth/verify-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: tempEmail, otp }) })).json();
        } catch (e) {
            setAuthVerifying(false);
            verifyOtpInFlight = false;
            alert('Connection error. Try again.');
            return;
        }
        if (!res.ok) {
            setAuthVerifying(false);
            verifyOtpInFlight = false;
            alert(res.error || 'Login failed');
            return;
        }

        suppressDismissUntilLibraryShown = true;
        try {
            try {
                Object.keys(localStorage).forEach((k) => {
                    if (k.startsWith('storage_files_')) localStorage.removeItem(k);
                });
            } catch (e) { }
            clearDriveMetaRefreshTimers();
            files = [];
            isLoadingUser = true;
            render();

            await init({ skipFilesFetch: true });
            await syncFilesAfterLogin();
        } catch (e) {
            console.error('Login flow error:', e);
            dismissLoginAfterCanvasPaint();
            verifyOtpInFlight = false;
            isLoadingUser = false;
            alert((e && e.message) || 'Không tải được thư viện. Hãy làm mới trang và thử lại.');
            return;
        }

        verifyOtpInFlight = false;
        fetch('/api/admin/ensure-spare', { method: 'POST' }).catch(() => { });
    }

    function findFreePosition(startX, startY, index) {
        // Chỉ đơn giản là trả về vị trí con trỏ, có dịch chuyển nhẹ nếu là cụm nhiều file
        return { 
            x: startX + (index * 10), 
            y: startY + (index * 10) 
        };
    }

    function getClientFileType(filename) {
        const ext = (filename.split('.').pop() || '').toLowerCase();
        const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'];
        const videoExts = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv'];
        if (imageExts.includes(ext)) return 'image';
        if (videoExts.includes(ext)) return 'video';
        return 'other';
    }

    function formatFileSizeClient(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    async function generateImageThumb(file) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const maxSize = 300;
                let w = img.width, h = img.height;
                if (w > maxSize || h > maxSize) {
                    if (w > h) { h = Math.round(h * (maxSize / w)); w = maxSize; }
                    else { w = Math.round(w * (maxSize / h)); h = maxSize; }
                }
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                c.getContext('2d').drawImage(img, 0, 0, w, h);
                c.toBlob((blob) => { URL.revokeObjectURL(img.src); resolve(blob); }, 'image/webp', 0.8);
            };
            img.onerror = () => { URL.revokeObjectURL(img.src); resolve(null); };
            img.src = URL.createObjectURL(file);
        });
    }

    async function generateVideoThumb(file) {
        return new Promise((resolve) => {
            let resolved = false;
            const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };

            const video = document.createElement('video');
            video.preload = 'metadata';
            video.muted = true; video.playsInline = true;
            
            video.onloadedmetadata = () => { video.currentTime = 0.1; };
            video.onseeked = () => {
                try {
                    const c = document.createElement('canvas');
                    c.width = video.videoWidth; c.height = video.videoHeight;
                    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
                    c.toBlob((blob) => { URL.revokeObjectURL(video.src); done(blob); }, 'image/webp', 0.8);
                } catch (e) { URL.revokeObjectURL(video.src); done(null); }
            };
            video.onerror = () => { URL.revokeObjectURL(video.src); done(null); };
            
            video.src = URL.createObjectURL(file);
            setTimeout(() => { URL.revokeObjectURL(video.src); done(null); }, 4000);
        });
    }

    async function uploadFiles(list, dx, dy) {
        if (!requireLogin()) return;

        for (let i = 0; i < list.length; i++) {
            const file = list[i];
            const pos = findFreePosition(dx, dy, i);
            const fileType = getClientFileType(file.name);
            const fileId = 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

            // === FOREGROUND: Thumbnail + Metadata lưu ngay ===

            // 1. Tạo thumbnail local để hiện ngay trên card
            let localThumbUrl = null;
            if (fileType === 'image') {
                localThumbUrl = URL.createObjectURL(file);
            }

            // 2. Tạo thumbnail blob (client-side) cho cả ảnh và video
            let thumbBlob = null;
            if (fileType === 'image') thumbBlob = await generateImageThumb(file);
            else if (fileType === 'video') thumbBlob = await generateVideoThumb(file);

            // 3. Upload thumbnail lên Drive qua server (nhỏ ~100KB, nhanh)
            let driveThumbnailId = null;
            if (thumbBlob) {
                const thumbFd = new FormData();
                thumbFd.append('thumb', thumbBlob, fileId + '.webp');
                thumbFd.append('fileId', fileId);
                try {
                    const thumbRes = await fetch('/api/upload/thumb', { method: 'POST', body: thumbFd });
                    if (thumbRes.ok) driveThumbnailId = (await thumbRes.json()).driveThumbnailId;
                } catch (e) { console.warn('Thumb upload skipped:', e.message); }
            }

            // 4. Tạo metadata đầy đủ (đã có thumbnail thật)
            const fileMeta = {
                id: fileId, name: file.name, filename: file.name, type: fileType,
                size: file.size, sizeFormatted: formatFileSizeClient(file.size),
                uploadedAt: new Date().toISOString(),
                hidden: false, position: pos,
                parentFolder: currentFolderId, groupId: currentGroupId,
                driveThumbnailId, localThumbUrl,
                isTemp: true,
            };

            // 5. Lưu metadata (vị trí, thumbnail, tên...) lên server TRƯỚC
            try {
                await fetch('/api/upload/complete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ files: [fileMeta] })
                });
            } catch (e) { console.error('Metadata save failed:', e.message); }

            // 6. SAU KHI đã lưu xong → Hiện card trên canvas
            files.push(fileMeta);
            saveToCache();
            render();

            // === BACKGROUND: Chỉ upload file gốc lên Drive chạy ngầm ===
            (async () => {
                try {
                    // Xin resumable upload URL
                    const initRes = await fetch('/api/upload/init', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            fileName: file.name,
                            mimeType: file.type || 'application/octet-stream',
                            fileSize: file.size,
                            parentFolder: currentFolderId,
                        })
                    });
                    if (!initRes.ok) throw new Error((await initRes.json().catch(() => ({}))).error || 'Init failed');
                    const { uploadUrl } = await initRes.json();

                    // Upload file trực tiếp lên Google Drive (không qua Vercel)
                    const driveRes = await fetch(uploadUrl, {
                        method: 'PUT',
                        headers: { 'Content-Type': file.type || 'application/octet-stream' },
                        body: file,
                    });
                    if (!driveRes.ok) throw new Error(`Drive upload failed: ${driveRes.status}`);
                    const driveData = await driveRes.json();

                    // Cập nhật driveFileId vào file
                    const f = files.find(x => x.id === fileId);
                    if (f) {
                        f.driveFileId = driveData.id;
                        f.isTemp = false;
                        if (f.localThumbUrl) {
                            URL.revokeObjectURL(f.localThumbUrl);
                            delete f.localThumbUrl;
                        }
                        // Cập nhật driveFileId lên server
                        fetch(`/api/files/${fileId}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ driveFileId: driveData.id })
                        }).catch(() => {});
                        saveToCache();
                        render();
                    }
                } catch (e) {
                    console.error('Background Drive upload failed:', e);
                }
            })();
        }
    }

    async function deleteFile(id) {
        const idx = files.findIndex(f => f.id === id);
        if (idx === -1) return;
        files.splice(idx, 1);
        saveToCache();
        render();

        if (!requireLogin()) return;
        await fetch(`/api/files/${id}`, { method: 'DELETE' });
    }

    async function updateFile(id, data) {
        const i = files.findIndex(f => f.id === id);
        if (i === -1) return null;

        // Optimistic update
        Object.assign(files[i], data);

        // Sync UI components
        const card = document.querySelector(`.file-card[data-id="${id}"]`);
        if (card) {
            if (data.name) {
                const nameEl = card.querySelector('.file-name');
                if (nameEl) nameEl.textContent = data.name;
                const previewTitle = card.querySelector('.note-preview-title');
                if (previewTitle) previewTitle.textContent = data.name;
            }
            if (data.content !== undefined) {
                const preview = card.querySelector('.note-preview-content');
                if (preview) preview.textContent = data.content ? data.content.replace(/<[^>]*>/g, ' ').substring(0, 100) : 'Empty note';
            }
        }

        // Sync Viewer
        if (currentViewerFile && currentViewerFile.id === id) {
            if (data.name) {
                const vt = document.getElementById('viewerTitle');
                if (vt) vt.textContent = data.name;
            }
        }

        if (files[i].isTemp) return files[i];
        if (!requireLogin()) return null;

        const r = await fetch(`/api/files/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        const u = await r.json();
        // Re-sync with server response but keep any very recent local changes
        const latestIdx = files.findIndex(f => f.id === id);
        if (latestIdx !== -1) {
            const currentName = files[latestIdx].name;
            const currentContent = files[latestIdx].content;
            const currentPos = files[latestIdx].position;
            Object.assign(files[latestIdx], u);
            files[latestIdx].name = currentName;
            files[latestIdx].position = currentPos;
            if (currentContent !== undefined) files[latestIdx].content = currentContent;
            saveToCache();
        }
        return files[latestIdx];
    }

    async function savePositions() {
        if (!isAuth) return;
        const posData = files.filter(f => f.position).map(f => ({ 
            id: f.id, 
            position: { x: Number(f.position.x), y: Number(f.position.y) } 
        }));
        await fetch('/api/positions', { 
            method: 'PUT', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(posData) 
        });
    }

    async function saveSinglePosition(id, position) {
        if (!isAuth) return;
        // Chỉ gửi vị trí của 1 file vừa di chuyển (tối ưu cho Production)
        await fetch('/api/positions', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ id, position: { x: Number(position.x), y: Number(position.y) } }]) });
    }

    function applyServerFiles(data) {
        if (!data) return;
        const incomingFiles = data.files || (Array.isArray(data) ? data : []);
        
        // Preserve current local positions to avoid jitter when syncing
        const posMap = new Map(files.map((x) => [x.id, x.position]));
        
        // 1. Lọc bỏ các file cũ không có trong danh sách mới từ Server
        const incomingIds = new Set(incomingFiles.map(f => f.id));
        files = files.filter(f => f.isTemp || incomingIds.has(f.id));

        // 2. Cập nhật hoặc thêm mới
        incomingFiles.forEach(sf => {
            const existing = files.find(f => f.id === sf.id);
            const localPos = posMap.get(sf.id);
            if (!existing) {
                sf.position = localPos || (sf.position ? { x: Number(sf.position.x), y: Number(sf.position.y) } : { x: 0, y: 0 });
                files.push(sf);
            } else {
                Object.assign(existing, sf);
                // ALWAYS prefer the local position if it exists so we don't snap back to older server positions
                if (localPos) {
                    existing.position = localPos;
                } else if (sf.position) {
                    existing.position = { x: Number(sf.position.x), y: Number(sf.position.y) };
                }
            }
        });
    }

    async function createFolder(pos) {
        const tempId = 'temp_' + Date.now();
        const f = {
            id: tempId, name: 'New Folder', type: 'folder', size: 0, sizeFormatted: '—', uploadedAt: new Date().toISOString(),
            hidden: false, position: { x: Number(pos.x), y: Number(pos.y) }, parentFolder: currentFolderId, groupId: currentGroupId, isTemp: true
        };
        files.push(f); render();
        setTimeout(() => startRename(tempId), 100);

        (async () => {
            const target = files.find(x => x.id === tempId);
            if (!target) return;
            const res = await (await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: target.position, groupId: target.groupId, parentFolder: target.parentFolder, name: target.name }) })).json();

            const idx = files.findIndex(x => x.id === tempId);
            if (idx !== -1) {
                const currentName = files[idx].name;
                const currentPos = files[idx].position; // Giữ lại vị trí hiện tại (phòng trường hợp người dùng vừa kéo đi)
                Object.assign(files[idx], res);
                files[idx].name = currentName;
                files[idx].position = currentPos;
                files[idx].isTemp = false;

                const card = document.querySelector(`.file-card[data-id="${tempId}"]`);
                if (card) card.dataset.id = res.id;
                if (currentViewerFile && currentViewerFile.id === tempId) currentViewerFile.id = res.id;
                saveToCache();
                render();
            }
        })();
    }

    async function createNote(pos) {
        const tempId = 'temp_' + Date.now();
        const n = {
            id: tempId, name: 'New Note.txt', type: 'note', size: 0, sizeFormatted: '0 B', uploadedAt: new Date().toISOString(),
            hidden: false, position: pos, content: '', parentFolder: currentFolderId, groupId: currentGroupId, isTemp: true
        };
        files.push(n); render();
        setTimeout(() => startRename(tempId), 100);

        (async () => {
            const target = files.find(x => x.id === tempId);
            if (!target) return;
            const res = await (await fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: target.position, groupId: target.groupId, parentFolder: target.parentFolder, name: target.name }) })).json();

            const idx = files.findIndex(x => x.id === tempId);
            if (idx !== -1) {
                const currentName = files[idx].name;
                const currentContent = files[idx].content;
                const currentPos = files[idx].position; // Giữ lại vị trí hiện tại
                Object.assign(files[idx], res);
                files[idx].name = currentName;
                files[idx].content = currentContent;
                files[idx].position = currentPos;
                files[idx].isTemp = false;

                const card = document.querySelector(`.file-card[data-id="${tempId}"]`);
                if (card) card.dataset.id = res.id;
                if (currentViewerFile && currentViewerFile.id === tempId) currentViewerFile.id = res.id;
                saveToCache();
                render();
            }
        })();
    }

    // Groups
    function renderGroups() {
        groupList.innerHTML = '';
        const sorted = [...groups].sort((a, b) => a.id === currentGroupId ? -1 : b.id === currentGroupId ? 1 : 0);
        sorted.forEach(g => {
            const item = document.createElement('div'); item.className = 'group-item' + (g.id === currentGroupId ? ' active' : '');
            const nm = document.createElement('span'); nm.className = 'group-item-name'; nm.textContent = g.name;
            item.appendChild(nm);
            item.addEventListener('click', async () => {
                currentGroupId = g.id; groupNameEl.textContent = g.name; currentFolderId = null; folderStack = []; updateFolderNav();
                files = await (await fetch(`/api/files?groupId=${currentGroupId}`)).json(); render(); renderGroups(); groupPopup.style.display = 'none';
            });
            nm.addEventListener('dblclick', e => {
                e.stopPropagation();
                if (!requireLogin()) return;
                const inp = document.createElement('input'); inp.className = 'group-rename-input'; inp.value = g.name;
                nm.replaceWith(inp); inp.focus(); inp.select();
                const fin = async () => { const v = inp.value.trim() || g.name; if (v !== g.name) { await fetch(`/api/groups/${g.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: v }) }); g.name = v; if (g.id === currentGroupId) groupNameEl.textContent = v; } renderGroups(); };
                inp.addEventListener('blur', fin); inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = g.name; inp.blur(); } });
            });
            groupList.appendChild(item);
        });
    }

    // Folder nav
    function navigateToFolder(id, name) { if (id) folderStack.push({ id, name }); currentFolderId = id; updateFolderNav(); render(); }
    function navigateBack() { folderStack.pop(); currentFolderId = folderStack.length ? folderStack[folderStack.length - 1].id : null; updateFolderNav(); render(); }
    function updateFolderNav() { folderNav.style.display = folderStack.length ? 'flex' : 'none'; if (folderStack.length) navPath.textContent = folderStack.map(f => f.name).join(' / '); }

    // Render
    function render() {
        const vf = getVisibleFiles();
        renderCardCountHint = vf.length;
        emptyState.style.display = (vf.length === 0 && !hiddenMode && !isLoadingUser) ? 'flex' : 'none';

        if (currentSort === 'default') {
            document.querySelectorAll('.sort-container').forEach(el => el.remove());
            const existing = new Map();
            document.querySelectorAll('.file-card').forEach(el => {
                if (el.classList.contains('sorted')) el.remove();
                else existing.set(el.dataset.id, el);
            });

            vf.forEach((f, i) => {
                let card = existing.get(f.id);
                if (card) {
                    // Cập nhật vị trí nếu có, nếu không mặc định 0,0 để không bị crash
                    const px = (f.position && typeof f.position.x === 'number') ? f.position.x : 0;
                    const py = (f.position && typeof f.position.y === 'number') ? f.position.y : 0;
                    card.style.left = px + 'px';
                    card.style.top = py + 'px';
                    
                    const nameEl = card.querySelector('.file-name');
                    if (nameEl) nameEl.textContent = f.name;
                    const metaEl = card.querySelector('.file-meta');
                    if (metaEl) {
                        const dtStr = fmtDate(f.uploadedAt);
                        metaEl.textContent = f.type === 'folder' ? dtStr : `${dtStr}\n${f.sizeFormatted || '—'}`;
                    }
                    if (f.type === 'note') {
                        const c = card.querySelector('.note-preview-content');
                        if (c) c.textContent = f.content ? f.content.replace(/<[^>]*>/g, ' ').substring(0, 100) : 'Empty note';
                    }
                    existing.delete(f.id);
                } else {
                    card = createFileCard(f, i, null, null);
                    canvas.appendChild(card);
                }
            });
            existing.forEach(el => el.remove());
        } else {
            document.querySelectorAll('.file-card:not(.in-grid)').forEach(el => el.remove());
            document.querySelectorAll('.sort-container').forEach(el => el.remove());
            const groupArr = [];
            vf.forEach(f => {
                let key = '';
                if (currentSort === 'type') {
                    if (f.type === 'folder') key = 'Folders';
                    else if (f.type === 'note') key = 'Notes';
                    else if (f.type === 'image') key = 'Images';
                    else if (f.type === 'video') key = 'Videos';
                    else key = 'Other Files';
                } else if (currentSort === 'date') {
                    const d = new Date(f.uploadedAt);
                    key = d.toLocaleDateString();
                } else if (currentSort === 'name') {
                    key = f.name.charAt(0).toUpperCase();
                }
                let lastGrp = groupArr[groupArr.length - 1];
                if (!lastGrp || lastGrp.key !== key) groupArr.push({ key, files: [f] });
                else lastGrp.files.push(f);
            });

            const sortContainer = document.createElement('div');
            sortContainer.className = 'sort-container';
            for (const grp of groupArr) {
                const groupEl = document.createElement('div');
                groupEl.className = 'sort-group';
                const hdr = document.createElement('div');
                hdr.className = 'sort-header-relative';
                hdr.textContent = grp.key;
                groupEl.appendChild(hdr);
                const grid = document.createElement('div');
                grid.className = 'sort-grid';
                grp.files.forEach((f, i) => {
                    const card = createFileCard(f, i, 0, 0);
                    card.classList.add('in-grid');
                    card.style.position = 'relative'; card.style.left = 'auto'; card.style.top = 'auto';
                    grid.appendChild(card);
                });
                groupEl.appendChild(grid);
                sortContainer.appendChild(groupEl);
            }
            canvas.appendChild(sortContainer);
        }
    }

    function getVisibleFiles() {
        let l = files.filter(f => (f.parentFolder || null) === currentFolderId);
        l = hiddenMode ? l.filter(f => f.hidden) : l.filter(f => !f.hidden);
        if (currentSort !== 'default') l = sortFiles(l, currentSort);
        return l;
    }

    function sortFiles(l, m) { const s = [...l]; switch (m) { case 'type': s.sort((a, b) => a.type.localeCompare(b.type)); break; case 'date': s.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)); break; case 'name': s.sort((a, b) => a.name.localeCompare(b.name)); break; }return s; }

    function createFileCard(file, index, fixedX, fixedY) {
        const card = document.createElement('div'); card.className = 'file-card'; card.dataset.id = file.id;
        const staggerCap = 20;
        const stagger = renderCardCountHint > staggerCap ? 0 : 0.042;
        card.style.animationDelay = `${Math.min(index, staggerCap) * stagger}s`;
        if (currentSort === 'default') { card.style.left = file.position.x + 'px'; card.style.top = file.position.y + 'px'; }
        else { card.classList.add('sorted'); card.style.left = fixedX + 'px'; card.style.top = fixedY + 'px'; }

        const thumb = document.createElement('div'); thumb.className = 'file-thumb';
        if (file.type === 'image') {
            thumb.classList.add('loading');
            const img = document.createElement('img');
            img.className = 'thumb-img';
            img.alt = file.name;
            img.decoding = 'async';
            img.fetchPriority = 'low';
            const url = thumbUrl(file);
            const thumbDone = () => {
                thumb.classList.remove('loading');
                img.classList.add('loaded');
            };
            img.onload = thumbDone;
            img.onerror = () => { thumb.classList.remove('loading'); };
            const obs = ensureThumbObserver();
            if (obs) {
                img.dataset.thumbSrc = url;
                obs.observe(img);
            } else {
                img.src = url;
            }
            thumb.appendChild(img);
            if (img.complete && img.naturalWidth > 0) thumbDone();
        } else if (file.type === 'video') {
            thumb.classList.add('loading');
            const img = document.createElement('img');
            img.className = 'thumb-img';
            img.alt = file.name;
            img.decoding = 'async';
            img.fetchPriority = 'low';
            const url = thumbUrl(file);
            const thumbDone = () => {
                thumb.classList.remove('loading');
                img.classList.add('loaded');
            };
            img.onload = thumbDone;
            img.onerror = () => { thumb.classList.remove('loading'); };
            const obs = ensureThumbObserver();
            if (obs) {
                img.dataset.thumbSrc = url;
                obs.observe(img);
            } else {
                img.src = url;
            }
            thumb.appendChild(img);
            if (img.complete && img.naturalWidth > 0) thumbDone();
            const badge = document.createElement('div'); badge.className = 'video-badge'; badge.innerHTML = `<svg viewBox="0 0 12 12" fill="none"><path d="M4 2.5L10 6L4 9.5V2.5Z" fill="white"/></svg>`; thumb.appendChild(badge);
        } else if (file.type === 'folder') {
            const img = document.createElement('img'); img.className = 'folder-icon'; img.src = '/icons/folder.png'; img.alt = 'folder'; img.draggable = false;
            thumb.appendChild(img);
            setTimeout(() => img.classList.add('loaded'), 10);
        } else if (file.type === 'note') {
            const pv = document.createElement('div'); pv.className = 'note-preview';
            const t = document.createElement('div'); t.className = 'note-preview-title'; t.textContent = file.name;
            const c = document.createElement('div'); c.className = 'note-preview-content'; c.textContent = file.content ? file.content.replace(/<[^>]*>/g, ' ').substring(0, 100) : 'Empty note';
            pv.appendChild(t); pv.appendChild(c); thumb.appendChild(pv);
            setTimeout(() => pv.classList.add('loaded'), 10);
        } else {
            const img = document.createElement('img'); img.className = 'file-icon'; img.src = '/icons/file.png'; img.alt = 'file'; img.draggable = false;
            thumb.appendChild(img);
            setTimeout(() => img.classList.add('loaded'), 10);
        }
        card.appendChild(thumb);

        const info = document.createElement('div'); info.className = 'file-info';
        const nameEl = document.createElement('div'); nameEl.className = 'file-name'; nameEl.textContent = file.name; nameEl.title = file.name; info.appendChild(nameEl);
        const metaEl = document.createElement('div'); metaEl.className = 'file-meta';
        const dtStr = fmtDate(file.uploadedAt);
        metaEl.textContent = file.type === 'folder' ? dtStr : `${dtStr}\n${file.sizeFormatted || '—'}`;
        metaEl.style.whiteSpace = 'pre-line'; info.appendChild(metaEl); card.appendChild(info);
        
        // Soft reveal animation class
        card.classList.add('is-revealing');
        setTimeout(() => {
            info.classList.add('loaded');
            card.classList.remove('is-revealing');
        }, 10);

        card.draggable = false;
        card.addEventListener('mousedown', e => {
            if (isSpaceDown) return;
            if (e.button !== 0 || e.target.tagName === 'INPUT') return;
            e.preventDefault();
            if (currentSort !== 'default') return;
            const liveFile = files.find(f => f.id === file.id) || file;
            const posX = parseFloat(card.style.left) || liveFile.position.x;
            const posY = parseFloat(card.style.top) || liveFile.position.y;
            dragState = { id: liveFile.id, startX: e.clientX, startY: e.clientY, offsetX: e.clientX - panX - posX, offsetY: e.clientY - panY - posY, moved: false, card };
            card.style.transition = 'none';
            card.classList.add('dragging');
        });
        card.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); const lf = files.find(f => f.id === file.id) || file; if (lf.type === 'folder') navigateToFolder(lf.id, lf.name); else openViewer(lf); });
        card.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); const lf = files.find(f => f.id === file.id) || file; contextTarget = lf.id; showCtx(ctxFile, e.clientX, e.clientY); const hb = ctxFile.querySelector('[data-action="hide"]'); if (hb) hb.textContent = lf.hidden ? 'Unhide' : 'Hide'; });
        return card;
    }

    function showCtx(m, x, y) { hideAllMenus(); m.style.display = 'block'; if (x + 200 > window.innerWidth) x = window.innerWidth - 210; if (y + 300 > window.innerHeight) y = window.innerHeight - 310; m.style.left = x + 'px'; m.style.top = y + 'px'; }
    function hideAllMenus() {
        [ctxCanvas, ctxFile, ctxGroup, sortDropdown, groupPopup, userAccPopup].forEach(m => { if (m) m.style.display = 'none'; });
        if (!suppressDismissUntilLibraryShown) {
            if (authFlowPopup) authFlowPopup.style.display = 'none';
            setAuthVerifying(false);
        }
    }

    function startRename(id) {
        if (!requireLogin()) return;
        const card = document.querySelector(`.file-card[data-id="${id}"]`); if (!card) return;
        const file = files.find(f => f.id === id); if (!file) return;
        const nameEl = card.querySelector('.file-name'); const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'file-name-input'; inp.value = file.name;
        nameEl.replaceWith(inp); inp.focus(); const d = file.name.lastIndexOf('.'); if (d > 0) inp.setSelectionRange(0, d); else inp.select();
        const fin = () => {
            const v = inp.value.trim() || file.name;
            const span = document.createElement('div'); span.className = 'file-name'; span.textContent = v;
            inp.replaceWith(span);
            if (v !== file.name) {
                file.name = v;
                updateFile(id, { name: v });
                const pt = card.querySelector('.note-preview-title'); if (pt) pt.textContent = v;
                if (currentViewerFile && currentViewerFile.id === id) {
                    currentViewerFile.name = v;
                    const vt = document.getElementById('viewerTitle');
                    if (vt) vt.textContent = v;
                }
            }
        };
        inp.addEventListener('blur', fin); inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = file.name; inp.blur(); } });
    }

    function syncCurrentNote() {
        if (currentViewerFile && currentViewerFile.type === 'note' && isAuth) {
            const i = files.findIndex(f => f.id === currentViewerFile.id);
            if (i !== -1) {
                updateFile(currentViewerFile.id, { content: files[i].content });
            }
        }
    }

    function openViewer(fileTarget) {
        const latestFile = files.find(f => f.id === fileTarget.id) || fileTarget;
        viewerFilesList = getVisibleFiles().filter(f => f.type !== 'folder');
        viewerIndex = viewerFilesList.findIndex(f => f.id === latestFile.id);
        if (viewerIndex === -1) { viewerFilesList = [latestFile]; viewerIndex = 0; }
        showFile(latestFile);
        viewerOverlay.style.display = 'flex';
    }

    function showFile(fileTarget) {
        if (currentViewerFile && currentViewerFile.id !== fileTarget.id) syncCurrentNote();
        const file = files.find(f => f.id === fileTarget.id) || fileTarget;
        currentViewerFile = file;
        viewerTitle.textContent = file.name;
        viewerTime.textContent = fmtDate(file.uploadedAt);
        viewerBody.innerHTML = ''; viewerToolbar.style.display = 'none';
        viewerPopup.classList.remove('viewer-small');
        viewerPopup.style.width = ''; viewerPopup.style.height = '';

        if (file.type === 'image') {
            viewerBody.innerHTML = '<div class="viewer-loading"></div>';
            const img = document.createElement('img');
            img.onload = () => {
                const maxW = window.innerWidth * 0.92 - 28, maxH = window.innerHeight * 0.92 - 70;
                let w = img.naturalWidth, h = img.naturalHeight;
                if (w > maxW) { h = h * (maxW / w); w = maxW; }
                if (h > maxH) { w = w * (maxH / h); h = maxH; }
                viewerPopup.style.width = Math.round(w + 28) + 'px';
                viewerBody.innerHTML = ''; viewerBody.appendChild(img);
            };
            img.onerror = () => {
                const f = files.find(x => x.id === file.id);
                if (f && (f.isTemp || !f.driveFileId)) {
                    setTimeout(() => {
                        if (viewerOverlay.style.display !== 'none' && currentViewerFile && currentViewerFile.id === file.id) {
                            img.src = rawUrl(f) + '&retry=' + Date.now();
                        }
                    }, 2000);
                } else {
                    viewerBody.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">Lỗi tải ảnh. Có thể tệp đã bị xóa hoặc tải lên thất bại.</div>';
                }
            };
            img.src = rawUrl(file);
            img.alt = file.name;
        } else if (file.type === 'video') {
            viewerBody.innerHTML = '<div class="viewer-loading"></div>';
            const v = document.createElement('video'); v.controls = true;
            v.onloadedmetadata = () => {
                const maxW = window.innerWidth * 0.92 - 28, maxH = window.innerHeight * 0.92 - 70;
                let w = v.videoWidth, h = v.videoHeight;
                if (w > maxW) { h = h * (maxW / w); w = maxW; }
                if (h > maxH) { w = w * (maxH / h); h = maxH; }
                viewerPopup.style.width = Math.round(w + 28) + 'px';
                viewerBody.innerHTML = ''; viewerBody.appendChild(v);
            };
            v.onerror = () => {
                const f = files.find(x => x.id === file.id);
                if (f && (f.isTemp || !f.driveFileId)) {
                    setTimeout(() => {
                        if (viewerOverlay.style.display !== 'none' && currentViewerFile && currentViewerFile.id === file.id) {
                            v.src = rawUrl(f) + '&retry=' + Date.now();
                        }
                    }, 2000);
                } else {
                    viewerBody.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">Lỗi tải video. Có thể tệp đã bị xóa hoặc tải lên thất bại.</div>';
                }
            };
            v.src = rawUrl(file);
        } else if (file.type === 'note') {
            viewerPopup.style.width = '700px'; viewerPopup.style.height = '90vh';
            viewerBody.style.alignItems = 'stretch'; viewerBody.style.display = 'block';
            const ed = document.createElement('div'); ed.className = 'note-editor';
            ed.contentEditable = isAuth ? 'true' : 'false';
            ed.innerHTML = file.content || '';
            if (isAuth) {
                let st;
                ed.addEventListener('input', () => {
                    const content = ed.innerHTML;
                    // Optimistic local update only
                    const i = files.findIndex(f => f.id === file.id); if (i !== -1) files[i].content = content;
                    const cardPreview = document.querySelector(`.file-card[data-id="${file.id}"] .note-preview-content`);
                    if (cardPreview) cardPreview.textContent = content ? content.replace(/<[^>]*>/g, ' ').substring(0, 100) : 'Empty note';
                    saveToCache();
                });
            }
            viewerBody.appendChild(ed);
            if (isAuth) viewerToolbar.style.display = 'flex';
        } else {
            viewerPopup.classList.add('viewer-small'); viewerPopup.style.width = ''; viewerPopup.style.height = '';
            viewerBody.innerHTML = `<div class="file-detail"><img class="detail-icon" src="/icons/file.png" alt="file"><div class="detail-name">${escHtml(file.name)}</div><div class="detail-meta">${file.sizeFormatted || '—'}<br>${fmtDate(file.uploadedAt)}</div></div>`;
        }
        viewerOverlay.style.display = 'flex';
    }

    function closeViewer() {
        const inp = document.querySelector('.viewer-title-input');
        if (inp) inp.blur();

        // Sync note content to server only when closing
        syncCurrentNote();

        viewerOverlay.style.display = 'none'; viewerBody.innerHTML = ''; viewerBody.style.alignItems = ''; viewerBody.style.display = ''; viewerToolbar.style.display = 'none';
    }
    function viewerNav(dir) {
        const list = getVisibleFiles().filter(f => f.type !== 'folder');
        const curIdx = list.findIndex(f => f.id === currentViewerFile.id);
        if (curIdx === -1) return;
        const nextIdx = curIdx + dir;
        if (nextIdx >= 0 && nextIdx < list.length) showFile(list[nextIdx]);
    }

    function startViewerRename() {
        if (!requireLogin()) return;
        const file = currentViewerFile; if (!file) return;
        const inp = document.createElement('input'); inp.className = 'viewer-title-input'; inp.value = file.name;
        viewerTitle.replaceWith(inp); inp.focus(); const d = file.name.lastIndexOf('.'); if (d > 0) inp.setSelectionRange(0, d); else inp.select();

        let finished = false;
        const fin = async () => {
            if (finished) return;
            finished = true;
            const v = inp.value.trim() || file.name;
            inp.replaceWith(viewerTitle);
            viewerTitle.textContent = v;
            if (v !== file.name) {
                file.name = v;
                updateFile(file.id, { name: v });
                const card = document.querySelector(`.file-card[data-id="${file.id}"]`);
                if (card) {
                    const cardName = card.querySelector('.file-name');
                    if (cardName) cardName.textContent = v;
                    const previewTitle = card.querySelector('.note-preview-title');
                    if (previewTitle) previewTitle.textContent = v;
                }
                const idxInList = viewerFilesList.findIndex(f => f.id === file.id);
                if (idxInList !== -1) viewerFilesList[idxInList].name = v;
            }
        };
        inp.addEventListener('blur', fin); inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = file.name; inp.blur(); } });
    }

    function applySortMode(m) { currentSort = m; sortDropdown.querySelectorAll('.sort-item').forEach(b => b.classList.toggle('active', b.dataset.sort === m)); render(); }
    function toggleHiddenMode(on) { hiddenMode = on; hiddenBanner.style.display = on ? 'flex' : 'none'; render(); }
    function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    let lastMouseX = window.innerWidth / 2;
    let lastMouseY = window.innerHeight / 2;

    function bindEvents() {
        const displacedFiles = new Map(); // id -> originalPosition
        
        document.addEventListener('mousemove', e => {
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
        });
        window.addEventListener('blur', () => {
            isSpaceDown = false;
            viewport.style.cursor = 'default';
            panState.active = false;
        });

        document.addEventListener('keyup', e => {
            if (e.code === 'Space') {
                isSpaceDown = false;
                viewport.style.cursor = 'default';
                panState.active = false;
            }
        });

        viewport.addEventListener('mousedown', e => {
            if (isSpaceDown && e.button === 0) {
                panState.active = true;
                panState.startX = e.clientX;
                panState.startY = e.clientY;
                panState.startPanX = panX;
                panState.startPanY = panY;
                viewport.style.cursor = 'grabbing';
                e.preventDefault();
            }
        });

        document.addEventListener('mousemove', e => {
            if (panState.active) {
                panX = panState.startPanX + (e.clientX - panState.startX);
                panY = panState.startPanY + (e.clientY - panState.startY);
                updateTransform();
                return;
            }
            if (!dragState) return; const dx = e.clientX - dragState.startX, dy = e.clientY - dragState.startY; if (!dragState.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) dragState.moved = true; if (dragState.moved) {
                const nx = e.clientX - panX - dragState.offsetX;
                const ny = e.clientY - panY - dragState.offsetY;
                dragState.card.style.left = nx + 'px'; dragState.card.style.top = ny + 'px';
                // Collision avoidance (Dựa trên diện tích thực tế của từng file)
                const others = files.filter(f => (f.parentFolder || null) === currentFolderId && !f.hidden && f.id !== dragState.id);
                
                const dragCard = dragState.card;
                const dW = dragCard.offsetWidth;
                const dH = dragCard.offsetHeight;

                others.forEach(f => {
                    if (!f.position) return;
                    const targetCard = document.querySelector(`.file-card[data-id="${f.id}"]`);
                    if (!targetCard) return;

                    const tW = targetCard.offsetWidth;
                    const tH = targetCard.offsetHeight;

                    // Kiểm tra va chạm diện tích (AABB collision) cho Bottom-anchored
                    const isColliding = (
                        nx < f.position.x + tW &&
                        nx + dW > f.position.x &&
                        (ny - dH) < f.position.y &&
                        ny > (f.position.y - tH)
                    );

                    if (isColliding) {
                        if (!displacedFiles.has(f.id)) displacedFiles.set(f.id, { x: f.position.x, y: f.position.y });
                        
                        // Né nhẹ nhàng (giảm khoảng cách và tăng độ mượt)
                        const pushX = nx > f.position.x ? -40 * scale : 40 * scale;
                        const pushY = ny > f.position.y ? -20 * scale : 20 * scale;
                        
                        f.position.x += pushX;
                        f.position.y += pushY;
                        
                        targetCard.style.transition = 'left 0.4s cubic-bezier(0.16, 1, 0.3, 1), top 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
                        targetCard.style.left = f.position.x + 'px';
                        targetCard.style.top = f.position.y + 'px';
                    }
                });

                // Return displaced files (Đo thực tế để quay về chỗ cũ chuẩn xác)
                displacedFiles.forEach((orig, id) => {
                    const f = files.find(x => x.id === id); if (!f) return;
                    const targetCard = document.querySelector(`.file-card[data-id="${id}"]`);
                    if (!targetCard) return;
                    
                    const tW = targetCard.offsetWidth;
                    const tH = targetCard.offsetHeight;

                    // Kiểm tra xem vị trí gốc (orig) có còn bị file đang kéo đè lên không
                    const isCollidingWithDrag = (
                        nx < orig.x + tW &&
                        nx + dW > orig.x &&
                        (ny - dH) < orig.y &&
                        ny > (orig.y - tH)
                    );

                    if (!isCollidingWithDrag) {
                        // Kiểm tra xem nếu quay về chỗ cũ có bị đè lên bởi các file khác không
                        const wouldCollide = others.some(o => {
                            if (o.id === id || !o.position) return false;
                            const oCard = document.querySelector(`.file-card[data-id="${o.id}"]`);
                            if (!oCard) return false;
                            const oW = oCard.offsetWidth;
                            const oH = oCard.offsetHeight;
                            
                            return (
                                orig.x < o.position.x + oW &&
                                orig.x + tW > o.position.x &&
                                orig.y < o.position.y + oH &&
                                orig.y + tH > o.position.y
                            );
                        });

                        if (!wouldCollide) {
                            f.position.x = orig.x;
                            f.position.y = orig.y;
                            targetCard.style.left = f.position.x + 'px';
                            targetCard.style.top = f.position.y + 'px';
                            displacedFiles.delete(id);
                        }
                    }
                });
            }
        });
        document.addEventListener('mouseup', async e => {
            if (panState.active) {
                panState.active = false;
                viewport.style.cursor = isSpaceDown ? 'grab' : 'default';
                return;
            }
            if (!dragState) return;

            const currentDrag = dragState;
            dragState = null; 
            currentDrag.card.classList.remove('dragging');
            displacedFiles.clear();

            if (currentDrag.moved) {
                // Lấy vị trí thực tế cuối cùng của Card từ style (đã được tính toán chuẩn trong mousemove)
                const nx = parseFloat(currentDrag.card.style.left);
                const ny = parseFloat(currentDrag.card.style.top);
                
                // Sử dụng ID hiện tại trên dataset thay vì ID gốc lúc mousedown (đề phòng ID thay đổi do server trả về lúc vừa tạo file)
                const currentFileId = currentDrag.card.dataset.id || currentDrag.id;
                
                const f = files.find(f => f.id === currentFileId);
                if (f) {
                    f.position = { x: nx, y: ny };
                    // Lưu vào cache ngay lập tức để F5 không bị mất
                    saveToCache();
                    // Lưu lên server
                    saveSinglePosition(f.id, f.position).catch(err => console.error('Save position failed:', err));
                }
            }
        });

        document.addEventListener('contextmenu', e => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
            if (e.target.closest('.context-menu') || e.target.closest('.float-btn') || e.target.closest('.user-acc-popup') || e.target.closest('.group-popup') || e.target.closest('.viewer-overlay')) return;
            if (e.target.closest('.file-card')) return;
            e.preventDefault();
            showCtx(ctxCanvas, e.clientX, e.clientY);
        });
        document.addEventListener('click', e => { const t = e.target; if (t.closest('.auth-flow-popup') || t.closest('.user-acc-popup') || t.closest('#btnAuth')) return; if (t.closest('.context-menu') || t.closest('.sort-dropdown') || t.closest('#btnSort') || t.closest('#btnGroup') || t.closest('.group-popup')) return; hideAllMenus(); });

        ctxCanvas.addEventListener('click', e => {
            const b = e.target.closest('[data-action]'); if (!b) return; const a = b.dataset.action; const mx = parseInt(ctxCanvas.style.left), my = parseInt(ctxCanvas.style.top);
            const pos = { x: mx - panX, y: my - panY }; hideAllMenus();
            switch (a) { case 'newNote': createNote(pos); break; case 'newFolder': createFolder(pos); break; case 'uploadFile': if (requireLogin()) fileInput.click(); break; case 'sortDefault': applySortMode('default'); break; case 'sortType': applySortMode('type'); break; case 'sortDate': applySortMode('date'); break; case 'sortName': applySortMode('name'); break; case 'invisible': toggleHiddenMode(true); break; }
        });

        ctxFile.addEventListener('click', async e => {
            const b = e.target.closest('[data-action]'); if (!b) return; const a = b.dataset.action; const id = contextTarget; hideAllMenus(); if (!id) return;
            switch (a) { case 'download': window.open(`/api/files/${id}/download`, '_blank'); break; case 'hide': { const f = files.find(f => f.id === id); if (f) { await updateFile(id, { hidden: !f.hidden }); render(); } break; } case 'rename': startRename(id); break; case 'delete': await deleteFile(id); break; }
        });

        // Group button
        btnGroup.addEventListener('click', e => { e.stopPropagation(); if (groupPopup.style.display === 'none') { hideAllMenus(); renderGroups(); groupPopup.style.display = 'block'; } else groupPopup.style.display = 'none'; });
        btnGroup.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); hideAllMenus(); showCtx(ctxGroup, e.clientX, e.clientY); });

        ctxGroup.addEventListener('click', async e => {
            const b = e.target.closest('[data-action]'); if (!b) return; hideAllMenus();
            if (b.dataset.action === 'renameGroup') {
                startGroupRename();
            } else if (b.dataset.action === 'deleteGroup') {
                if (!requireLogin()) return;
                if (groups.length <= 1) return alert('Cannot delete last group');
                customConfirm('Delete this group?', async () => {
                    await fetch(`/api/groups/${currentGroupId}`, { method: 'DELETE' }); groups = groups.filter(g => g.id !== currentGroupId); currentGroupId = groups[0].id; groupNameEl.textContent = groups[0].name;
                    files = await (await fetch(`/api/files?groupId=${currentGroupId}`)).json(); currentFolderId = null; folderStack = []; updateFolderNav(); render();
                });
            }
        });

        btnAddGroup.addEventListener('click', async () => {
            if (!isAuth) return;
            const g = await (await fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'New Group' }) })).json();
            groups.push(g);
            currentGroupId = g.id;
            groupNameEl.textContent = g.name;
            files = [];
            render();
            renderGroups();
            startGroupRename();
        });
        btnSort.addEventListener('click', e => { e.stopPropagation(); if (sortDropdown.style.display === 'none') { hideAllMenus(); sortDropdown.style.display = 'block'; } else sortDropdown.style.display = 'none'; });
        sortDropdown.addEventListener('click', e => { const b = e.target.closest('.sort-item'); if (!b) return; applySortMode(b.dataset.sort); sortDropdown.style.display = 'none'; });

        navBack.addEventListener('click', navigateBack);
        btnBack.addEventListener('click', () => toggleHiddenMode(false));

        // auth flows

        // Viewer
        viewerClose.addEventListener('click', closeViewer);
        viewerOverlay.addEventListener('click', e => { if (e.target === viewerOverlay) closeViewer(); });
        viewerPrev.addEventListener('click', () => viewerNav(-1));
        viewerNext.addEventListener('click', () => viewerNav(1));
        viewerTitle.addEventListener('click', startViewerRename);

        // Toolbar
        viewerToolbar.addEventListener('click', e => { const b = e.target.closest('[data-cmd]'); if (!b) return; document.execCommand(b.dataset.cmd, false, null); const ed = viewerBody.querySelector('.note-editor'); if (ed) ed.focus(); });

        document.addEventListener('keydown', e => {
            if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && !e.target.isContentEditable) {
                e.preventDefault();
                if (!isSpaceDown) { isSpaceDown = true; viewport.style.cursor = 'grab'; }
            }
            if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); updateScale(0.1); }
            if (e.ctrlKey && (e.key === '-' || e.key === '_')) { e.preventDefault(); updateScale(-0.1); }
            if (e.ctrlKey && (e.code === 'Digit0' || e.code === 'Numpad0')) {
                e.preventDefault();
                e.stopImmediatePropagation();
                hideAllMenus();
                scale = 1.0;
                document.documentElement.style.setProperty('--card-scale', 1.0);
                focusContent({ smooth: true }); return;
            }
            if ((e.code === 'Digit0' || e.code === 'Numpad0') && e.target.tagName !== 'INPUT') {
                e.preventDefault();
                scale = 1.0;
                document.documentElement.style.setProperty('--card-scale', scale);
                focusContent({ smooth: true });
            }
            if (e.key === 'Escape') { if (viewerOverlay.style.display !== 'none') closeViewer(); hideAllMenus(); }
            if (viewerOverlay.style.display !== 'none' && e.target.tagName !== 'INPUT') {
                if (e.key === 'ArrowLeft') viewerNav(-1);
                if (e.key === 'ArrowRight') viewerNav(1);
            }
        });

        window.addEventListener('wheel', e => {
            if (e.ctrlKey) {
                e.preventDefault();
                updateScale(e.deltaY > 0 ? -0.1 : 0.1);
            }
        }, { passive: false });

        fileInput.addEventListener('change', async e => { if (e.target.files.length > 0) { await uploadFiles(e.target.files, window.innerWidth / 2 - panX, window.innerHeight / 2 - panY); fileInput.value = ''; } });

        document.addEventListener('paste', async e => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
            if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
                const cx = lastMouseX - panX;
                const cy = lastMouseY - panY;
                await uploadFiles(e.clipboardData.files, cx, cy);
            }
        });

        // Drag & drop
        document.addEventListener('dragenter', e => e.preventDefault());
        document.addEventListener('dragleave', e => e.preventDefault());
        document.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
        document.addEventListener('drop', async e => {
            e.preventDefault(); if (e.dataTransfer.files.length > 0) {
                const cx = e.clientX - panX;
                const cy = e.clientY - panY;
                await uploadFiles(e.dataTransfer.files, cx, cy);
            }
        });
    }

    document.addEventListener('DOMContentLoaded', init);
})();
