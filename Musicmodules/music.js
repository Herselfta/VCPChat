// Musicmodules/music.js - Rewritten for Python Hi-Fi Audio Engine
document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Element Selections ---
    const playPauseBtn = document.getElementById('play-pause-btn');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const modeBtn = document.getElementById('mode-btn');
    const volumeBtn = document.getElementById('volume-btn'); // 音量功能暂时由UI控制，不与引擎交互
    const volumeSlider = document.getElementById('volume-slider'); // 同上
    const progressContainer = document.querySelector('.progress-container');
    const progressBar = document.querySelector('.progress-bar');
    const progress = document.querySelector('.progress');
    const currentTimeEl = document.querySelector('.current-time');
    const durationEl = document.querySelector('.duration');
    const albumArt = document.querySelector('.album-art');
    const albumArtWrapper = document.querySelector('.album-art-wrapper');
    const trackTitle = document.querySelector('.track-title');
    const trackArtist = document.querySelector('.track-artist');
    const trackBitrate = document.querySelector('.track-bitrate');
    const playlistEl = document.getElementById('playlist');
    const addFolderBtn = document.getElementById('add-folder-btn');
    const searchInput = document.getElementById('search-input');
    const loadingIndicator = document.getElementById('loading-indicator');
    const scanProgressContainer = document.querySelector('.scan-progress-container');
    const scanProgressBar = document.querySelector('.scan-progress-bar');
    const scanProgressLabel = document.querySelector('.scan-progress-label');
    const playerBackground = document.getElementById('player-background');
    const visualizerCanvas = document.getElementById('visualizer');
    const visualizerCtx = visualizerCanvas.getContext('2d');
    const shareBtn = document.getElementById('share-btn');
    // --- New UI Elements for WASAPI ---
    const deviceSelect = document.getElementById('device-select');
    const wasapiSwitch = document.getElementById('wasapi-switch');
    const eqSwitch = document.getElementById('eq-switch');
    const eqBandsContainer = document.getElementById('eq-bands');
    const eqPresetSelect = document.getElementById('eq-preset-select');
    const eqSection = document.getElementById('eq-section');
    const eqTypeSelect = document.getElementById('eq-type-select');
    const ditherSwitch = document.getElementById('dither-switch');
    const replaygainSwitch = document.getElementById('replaygain-switch');
    const upsamplingSelect = document.getElementById('upsampling-select');
    const lyricsContainer = document.getElementById('lyrics-container');
    const lyricsList = document.getElementById('lyrics-list');

    const phantomAudio = document.getElementById('phantom-audio');

    // --- Custom Title Bar ---
    const minimizeBtn = document.getElementById('minimize-music-btn');
    const maximizeBtn = document.getElementById('maximize-music-btn');
    const closeBtn = document.getElementById('close-music-btn');

    // --- Sidebar Elements ---
    const leftSidebar = document.getElementById('left-sidebar');
    const sidebarTabs = document.querySelectorAll('.sidebar-tab');
    const sidebarContent = document.getElementById('sidebar-content');
    const sidebarFooter = document.getElementById('sidebar-footer');
    const createPlaylistBtn = document.getElementById('create-playlist-btn');

    // --- Context Menu Elements ---
    const contextMenu = document.getElementById('track-context-menu');
    const playlistSubmenu = document.getElementById('playlist-submenu');

    // --- Dialog Elements ---
    const playlistDialog = document.getElementById('playlist-dialog');
    const playlistNameInput = document.getElementById('playlist-name-input');
    const dialogCancel = document.getElementById('dialog-cancel');
    const dialogConfirm = document.getElementById('dialog-confirm');

    // --- Playlist Edit Modal Elements ---
    const playlistEditModal = document.getElementById('playlist-edit-modal');
    const modalPlaylistTitle = document.getElementById('modal-playlist-title');
    const modalSearchInput = document.getElementById('modal-search-input');
    const modalSongList = document.getElementById('modal-song-list');
    const modalCount = document.getElementById('modal-count');
    const modalCloseBtn = document.getElementById('modal-close-btn');
    const modalDoneBtn = document.getElementById('modal-done-btn');

    // --- State Variables ---
    let playlist = [];
    let currentTrackIndex = 0;
    let isPlaying = false; // 本地UI状态，会与引擎同步
    const playModes = ['repeat', 'repeat-one', 'shuffle'];
    let currentPlayMode = 0;
    let currentTheme = 'dark';
    let currentLyrics = [];
    let currentLyricIndex = -1;
    let lyricOffset = -0.05; // In seconds. Negative value makes lyrics appear earlier to compensate for UI lag.
    let lyricSpeedFactor = 1.0; // Should be 1.0 for correctly timed LRC files.
    let lastKnownCurrentTime = 0;
    let lastStateUpdateTime = 0;
    let lastKnownDuration = 0;
    let wnpAdapter; // Rainmeter WebNowPlaying Adapter
    let visualizerColor = { r: 118, g: 106, b: 226 };
    let statePollInterval; // 用于轮询状态的定时器
    let currentDeviceId = null;
    let useWasapiExclusive = false;
    let targetUpsamplingRate = 0;
    let eqEnabled = false;

    // --- Sidebar State ---
    let currentSidebarView = 'all';
    let customPlaylists = [];
    let filteredPlaylistSource = null; // { type: 'album'|'artist'|'playlist', name: string, id?: number }
    let pendingAddToPlaylist = null; // Callback for dialog
    let editingPlaylistId = null; // Currently editing playlist in modal
    let modalSearchQuery = ''; // Search filter for modal
    let lastModalClickIndex = -1; // For shift-select in modal
    let currentFilteredTracks = null; // Active playlist tracks for shuffle scope
    let shuffleQueue = [];
    let lastShuffleList = null;

    const eqBands = {
        '31': 0, '62': 0, '125': 0, '250': 0, '500': 0,
        '1k': 0, '2k': 0, '4k': 0, '8k': 0, '16k': 0
    };
    const eqPresets = {
        'balance': { '31': 0, '62': 0, '125': 0, '250': 0, '500': 0, '1k': 0, '2k': 0, '4k': 0, '8k': 0, '16k': 0 },
        'classical': { '31': 0, '62': 0, '125': 0, '250': -2, '500': -4, '1k': -5, '2k': -4, '4k': -3, '8k': 2, '16k': 3 },
        'pop': { '31': 2, '62': 4, '125': 5, '250': 2, '500': -1, '1k': -2, '2k': 0, '4k': 3, '8k': 4, '16k': 5 },
        'rock': { '31': 5, '62': 3, '125': -2, '250': -4, '500': -1, '1k': 2, '2k': 5, '4k': 6, '8k': 7, '16k': 7 },
        'electronic': { '31': 6, '62': 5, '125': 2, '250': 0, '500': -2, '1k': 0, '2k': 3, '4k': 5, '8k': 6, '16k': 7 },
        'acg_vocal': { '31': 1, '62': 2, '125': -1, '250': 1, '500': -2, '1k': 2, '2k': 5, '4k': 4, '8k': 3, '16k': 2 },
    };
    let isDraggingProgress = false;

    // --- Visualizer State ---
    let animationFrameId;
    let targetVisualizerData = [];
    let currentVisualizerData = [];
    const easingFactor = 0.2; // 缓动因子，值越小动画越平滑
    let bassScale = 1.0; // 用于专辑封面 Bass 动画
    const BASS_BOOST = 1.06; // Bass 触发时的放大系数
    const BASS_DECAY = 0.96; // 动画恢复速度
    const BASS_THRESHOLD = 0.55; // Bass 触发阈值
    let particles = []; // 用于存储粒子
    const PARTICLE_COUNT = 80; // 定义粒子数量

    // --- Particle Class ---
    class Particle {
        constructor(x, y) {
            this.x = x;
            this.y = y;
            this.targetY = y;
            this.vy = 0; // Vertical velocity
            this.size = 1.1;
            this.spring = 0.08; // Spring stiffness
            this.friction = 0.85; // Friction/damping
        }

        update() {
            // Spring physics for a bouncy effect
            const dy = this.targetY - this.y;
            const ay = dy * this.spring;
            this.vy += ay;
            this.vy *= this.friction;
            this.y += this.vy;
        }

    }

    const recreateParticles = () => {
        particles.length = 0; // Clear existing particles, more performant
        if (visualizerCanvas.width > 0) {
            // Distribute particles across the full width of the canvas
            for (let i = 0; i < PARTICLE_COUNT; i++) {
                // This ensures the first particle is at x=0 and the last is at x=width
                const x = visualizerCanvas.width * (i / (PARTICLE_COUNT - 1));
                // Initially place them slightly above the bottom
                particles.push(new Particle(x, visualizerCanvas.height - 10));
            }
        }
    };

    // --- WebSocket for Visualization (Native WebSocket) ---
    // Replaced socket.io with native WebSocket for Rust server compatibility
    let ws = null;
    const connectWebSocket = () => {
        ws = new WebSocket("ws://127.0.0.1:63789/ws");

        ws.onopen = () => {
            console.log('[Music.js] Connected to Rust Audio Engine via WebSocket.');
            if (!animationFrameId) {
                startVisualizerAnimation(); // Start animation loop
            }
        };

        ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'spectrum_data') {
                    if (isPlaying) {
                        targetVisualizerData = message.data;
                        if (currentVisualizerData.length === 0) {
                            currentVisualizerData = Array(targetVisualizerData.length).fill(0);
                        }
                    }
                }
            } catch (e) {
                console.error('[Music.js] Failed to parse WebSocket message:', e);
            }
        };

        ws.onclose = () => {
            // console.log('[Music.js] Disconnected from Rust Audio Engine WebSocket. Retrying in 5s...');
            setTimeout(connectWebSocket, 5000);
        };

        ws.onerror = (err) => {
            console.error('[Music.js] WebSocket error:', err);
            ws.close();
        };
    };

    connectWebSocket();


    // --- Helper Functions ---
    const formatTime = (seconds) => {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    };

    const updateBlurredBackground = (imageUrl) => {
        if (playerBackground) {
            // 如果 imageUrl 是 'none'，它会清除背景图片，从而显示全局背景
            playerBackground.style.backgroundImage = imageUrl;
        }
    };

    const hexToRgb = (hex) => {
        if (!hex) return null;
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    };

    // --- Rainmeter WebNowPlaying Adapter ---
    class WebNowPlayingAdapter {
        constructor() {
            this.ws = null;
            this.reconnectInterval = 5000; // 5 seconds
            this.connect();
        }

        connect() {
            try {
                // WebNowPlaying default port is 8974
                this.ws = new WebSocket('ws://127.0.0.1:8974');

                this.ws.onopen = () => {
                    console.log('[WebNowPlaying] Connected to Rainmeter.');
                    this.sendUpdate(); // Send initial state
                };

                this.ws.onerror = (err) => {
                    // This will fire on connection refusal, ignore silently
                    this.ws = null;
                };

                this.ws.onclose = () => {
                    // Automatically try to reconnect
                    this.ws = null;
                    setTimeout(() => this.connect(), this.reconnectInterval);
                };
            } catch (e) {
                setTimeout(() => this.connect(), this.reconnectInterval);
            }
        }

        sendUpdate() {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

            const track = playlist.length > 0 ? playlist[currentTrackIndex] : null;
            const currentMode = playModes[currentPlayMode];

            const data = {
                player: 'VCP Music Player',
                state: !track ? 0 : (isPlaying ? 1 : 2), // 0=stopped, 1=playing, 2=paused
                title: track ? track.title || '' : 'No Track Loaded',
                artist: track ? track.artist || '' : '',
                album: track ? track.album || '' : '',
                cover: track && track.albumArt ? 'file://' + track.albumArt.replace(/\\/g, '/') : '',
                duration: lastKnownDuration || 0,
                position: lastKnownCurrentTime || 0,
                volume: Math.round(parseFloat(volumeSlider.value) * 100),
                rating: 0, // Not implemented
                // WebNowPlaying standard: 0=off, 1=repeat track, 2=repeat playlist
                repeat: currentMode === 'repeat-one' ? 1 : (currentMode === 'repeat' ? 2 : 0),
                shuffle: currentMode === 'shuffle' ? 1 : 0
            };

            try {
                this.ws.send(JSON.stringify(data));
            } catch (e) {
                console.error('[WebNowPlaying] Failed to send update:', e);
            }
        }
    }

    // --- Media Session API Integration ---
    const setupMediaSessionHandlers = () => {
        if (!('mediaSession' in navigator)) {
            return;
        }
        // 显式绑定 MediaSession 动作，确保 AirPods 手势能触发 playTrack/pauseTrack
        navigator.mediaSession.setActionHandler('play', () => {
            console.log('[MediaSession] Play action triggered');
            playTrack();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            console.log('[MediaSession] Pause action triggered');
            pauseTrack();
        });
        navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
        navigator.mediaSession.setActionHandler('nexttrack', nextTrack);

        // 监听 phantomAudio 的播放事件，作为 AirPods 手势的补充触发源
        phantomAudio.onplay = () => {
            if (!isPlaying) {
                console.log('[PhantomAudio] Play event detected');
                playTrack();
            }
        };
        phantomAudio.onpause = () => {
            if (isPlaying) {
                console.log('[PhantomAudio] Pause event detected');
                pauseTrack();
            }
        };
    };

    const updateMediaSessionMetadata = () => {
        if (!('mediaSession' in navigator) || playlist.length === 0 || !playlist[currentTrackIndex]) {
            return;
        }
        const track = playlist[currentTrackIndex];
        const artworkSrc = track.albumArt ? `file://${track.albumArt.replace(/\\/g, '/')}` : '';

        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title || '未知标题',
            artist: track.artist || '未知艺术家',
            album: track.album || 'VCP Music Player', // Default album name
            artwork: artworkSrc ? [{ src: artworkSrc }] : []
        });

        // 强制更新播放状态，确保系统控制中心与引擎同步
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    };

    // --- Core Player Logic ---
    const loadTrack = async (trackIndex, andPlay = true) => {
        if (playlist.length === 0) {
            // 清空UI
            trackTitle.textContent = '未选择歌曲';
            trackArtist.textContent = '未知艺术家';
            trackBitrate.textContent = '';
            const defaultArtUrl = `url('../assets/${currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
            albumArt.style.backgroundImage = defaultArtUrl;
            updateBlurredBackground('none'); // 没有歌曲时，回退到全局背景
            renderPlaylist(currentFilteredTracks);
            return;
        }

        currentTrackIndex = trackIndex;
        const track = playlist[trackIndex];

        // 更新UI
        trackTitle.textContent = track.title || '未知标题';
        trackArtist.textContent = track.artist || '未知艺术家';
        if (track.bitrate) {
            trackBitrate.textContent = `${Math.round(track.bitrate / 1000)} kbps`;
        } else {
            trackBitrate.textContent = '';
        }

        const defaultArtUrl = `url('../assets/${currentTheme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
        if (track.albumArt) {
            const albumArtUrl = `url('file://${track.albumArt.replace(/\\/g, '/')}')`;
            albumArt.style.backgroundImage = albumArtUrl;
            updateBlurredBackground(albumArtUrl);
        } else {
            albumArt.style.backgroundImage = defaultArtUrl;
            updateBlurredBackground('none'); // 没有封面时，回退到全局背景
        }

        renderPlaylist(currentFilteredTracks);
        fetchAndDisplayLyrics(track.artist, track.title);
        updateMediaSessionMetadata(); // Update OS media controls
        if (wnpAdapter) wnpAdapter.sendUpdate();

        // 通过IPC让主进程通知Python引擎加载文件
        const result = await window.electron.invoke('music-load', track);
        if (result && result.status === 'success') {
            updateUIWithState(result.state);
            if (andPlay) {
                playTrack();
            }
        } else {
            console.error("Failed to load track in audio engine:", result.message);
        }
    };

    const playTrack = async () => {
        if (playlist.length === 0) return;
        const result = await window.electron.invoke('music-play');
        if (result.status === 'success') {
            isPlaying = true;
            playPauseBtn.classList.add('is-playing');
            // AirPods 手势恢复播放依赖于 phantomAudio 的状态同步
            // 循环播放占位音频，防止其结束后导致 MediaSession 状态失效
            phantomAudio.loop = true;
            phantomAudio.play().catch(e => console.error("Phantom audio play failed:", e));

            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'playing';
            }
            startStatePolling();
            if (wnpAdapter) wnpAdapter.sendUpdate();
        }
    };

    const pauseTrack = async () => {
        const result = await window.electron.invoke('music-pause');
        if (result.status === 'success') {
            isPlaying = false;
            playPauseBtn.classList.remove('is-playing');
            // AirPods 离开耳朵或手势暂停时，同步暂停 phantomAudio
            phantomAudio.pause();
            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'paused';
            }
            stopStatePolling();
            if (wnpAdapter) wnpAdapter.sendUpdate();
        }
    };

    const prevTrack = () => {
        currentTrackIndex = (currentTrackIndex - 1 + playlist.length) % playlist.length;
        loadTrack(currentTrackIndex);
        if (wnpAdapter) wnpAdapter.sendUpdate();
    };

    const nextTrack = () => {
        // Use filtered tracks if a playlist is active, otherwise use all tracks
        const activeList = currentFilteredTracks || playlist;

        // Reset shuffle queue if the active list has changed
        if (lastShuffleList !== activeList) {
            shuffleQueue = [];
            lastShuffleList = activeList;
        }

        if (activeList.length <= 1) {
            if (activeList.length === 1) {
                const track = activeList[0];
                const idx = playlist.indexOf(track);
                if (idx !== -1) loadTrack(idx);
            }
            return;
        }

        switch (playModes[currentPlayMode]) {
            case 'repeat':
                // Find current track's position in active list
                const currentTrack = playlist[currentTrackIndex];
                const currentPosInActive = activeList.indexOf(currentTrack);
                if (currentPosInActive !== -1) {
                    const nextPosInActive = (currentPosInActive + 1) % activeList.length;
                    const nextTrack = activeList[nextPosInActive];
                    currentTrackIndex = playlist.indexOf(nextTrack);
                } else {
                    // Current track not in active list, pick first from active
                    currentTrackIndex = playlist.indexOf(activeList[0]);
                }
                break;
            case 'repeat-one':
                // 引擎会在播放结束时停止，我们需要在这里重新加载并播放
                break;
            case 'shuffle':
                // If queue is empty, refill it with all indices from activeList
                if (shuffleQueue.length === 0) {
                    shuffleQueue = Array.from({ length: activeList.length }, (_, i) => i);
                    // Fisher-Yates shuffle algorithm
                    for (let i = shuffleQueue.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [shuffleQueue[i], shuffleQueue[j]] = [shuffleQueue[j], shuffleQueue[i]];
                    }
                    
                    // Avoid playing the same song again immediately if it's the first in the new queue
                    if (shuffleQueue.length > 1) {
                        const firstTrack = activeList[shuffleQueue[0]];
                        if (playlist.indexOf(firstTrack) === currentTrackIndex) {
                            // Move the first element to the end
                            shuffleQueue.push(shuffleQueue.shift());
                        }
                    }
                }
                
                const nextIndexInActive = shuffleQueue.shift();
                const selectedTrack = activeList[nextIndexInActive];
                currentTrackIndex = playlist.indexOf(selectedTrack);
                break;
        }
        loadTrack(currentTrackIndex);
        if (wnpAdapter) wnpAdapter.sendUpdate();
    };

    // --- UI Update and State Management ---
    const updateUIWithState = (state) => {
        if (!state) return;

        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = (state.is_playing && !state.is_paused) ? 'playing' : 'paused';
        }

        isPlaying = state.is_playing && !state.is_paused;
        playPauseBtn.classList.toggle('is-playing', isPlaying);

        const duration = state.duration || 0;
        lastKnownDuration = duration; // Store for WebNowPlaying
        const currentTime = state.current_time || 0;
        lastKnownCurrentTime = currentTime;
        lastStateUpdateTime = Date.now();

        durationEl.textContent = formatTime(duration);
        currentTimeEl.textContent = formatTime(currentTime);

        const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
        progress.style.width = `${progressPercent}%`;

        // 检查播放是否已结束
        if (state.is_playing === false && currentTrackIndex !== -1 && currentTime > 0) {
            // 播放结束
            // console.log("Playback seems to have ended.");
            stopStatePolling();
            if (playModes[currentPlayMode] === 'repeat-one') {
                loadTrack(currentTrackIndex, true);
            } else {
                nextTrack();
            }
        }
        // Update device selection UI
        if (deviceSelect.value !== state.device_id) {
            deviceSelect.value = state.device_id;
        }
        if (wasapiSwitch.checked !== state.exclusive_mode) {
            wasapiSwitch.checked = state.exclusive_mode;
        }
        // Update EQ UI
        if (state.eq_enabled !== undefined && eqSwitch.checked !== state.eq_enabled) {
            eqSwitch.checked = state.eq_enabled;
            eqSection.classList.toggle('expanded', state.eq_enabled);
        }
        if (state.eq_type !== undefined && eqTypeSelect.value !== state.eq_type && !eqTypeSelect.matches(':focus')) {
            eqTypeSelect.value = state.eq_type;
        }
        if (state.dither_enabled !== undefined && ditherSwitch.checked !== state.dither_enabled) {
            ditherSwitch.checked = state.dither_enabled;
        }
        if (state.replaygain_enabled !== undefined && replaygainSwitch.checked !== state.replaygain_enabled) {
            replaygainSwitch.checked = state.replaygain_enabled;
        }
        if (state.eq_bands) {
            for (const [band, gain] of Object.entries(state.eq_bands)) {
                const slider = document.getElementById(`eq-${band}`);
                if (slider && slider.value !== gain) {
                    slider.value = gain;
                }
                eqBands[band] = gain;
            }
        }
        // Update upsampling UI
        if (state.target_samplerate !== undefined && upsamplingSelect.value !== state.target_samplerate) {
            upsamplingSelect.value = state.target_samplerate || 0;
        }
        if (wnpAdapter) wnpAdapter.sendUpdate();
    };

    const pollState = async () => {
        const result = await window.electron.invoke('music-get-state');
        if (result.status === 'success') {
            updateUIWithState(result.state);
        }
    };

    const startStatePolling = () => {
        if (statePollInterval) clearInterval(statePollInterval);
        statePollInterval = setInterval(pollState, 250); // 每250ms更新一次进度
    };

    const stopStatePolling = () => {
        clearInterval(statePollInterval);
        statePollInterval = null;
    };


    // --- Visualizer ---
    const startVisualizerAnimation = () => {
        const draw = () => {
            if (isPlaying) {
                animateLyrics();
            }

            // --- Bass Animation Logic ---
            if (isPlaying && currentVisualizerData.length > 0 && albumArtWrapper) {
                // 从低频段计算 Bass 能量
                const bassBinCount = Math.floor(currentVisualizerData.length * 0.05); // 取前5%的频段
                let bassEnergy = 0;
                for (let i = 0; i < bassBinCount; i++) {
                    bassEnergy += currentVisualizerData[i];
                }
                bassEnergy /= bassBinCount; // 平均能量

                // 如果 Bass 能量超过阈值，则触发动画
                if (bassEnergy > BASS_THRESHOLD && bassScale < BASS_BOOST) {
                    bassScale = BASS_BOOST;
                } else {
                    // 动画效果逐渐衰减回原样
                    bassScale = Math.max(1.0, bassScale * BASS_DECAY);
                }

                albumArtWrapper.style.transform = `scale(${bassScale})`;
            }
            // --- End Bass Animation Logic ---

            if (targetVisualizerData.length === 0) {
                visualizerCtx.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
                animationFrameId = requestAnimationFrame(draw);
                return;
            }

            // 使用缓动公式更新当前数据
            for (let i = 0; i < targetVisualizerData.length; i++) {
                if (currentVisualizerData[i] === undefined) {
                    currentVisualizerData[i] = 0;
                }
                currentVisualizerData[i] += (targetVisualizerData[i] - currentVisualizerData[i]) * easingFactor;
            }

            // 使用平滑后的当前数据进行绘制
            drawVisualizer(currentVisualizerData);

            // 更新和绘制粒子
            // 更新和绘制粒子
            // First, update all particle positions based on the spectrum
            particles.forEach(p => {
                // 找到粒子对应的频谱数据点
                const positionRatio = p.x / visualizerCanvas.width;
                const dataIndexFloat = positionRatio * (currentVisualizerData.length - 1);
                const index1 = Math.floor(dataIndexFloat);
                const index2 = Math.min(index1 + 1, currentVisualizerData.length - 1);

                // Linear interpolation for smooth height transition between data points
                const value1 = currentVisualizerData[index1] || 0;
                const value2 = currentVisualizerData[index2] || 0;
                const fraction = dataIndexFloat - index1;
                const interpolatedValue = value1 + (value2 - value1) * fraction;

                // 计算目标Y值，让粒子在频谱线上方一点
                const spectrumY = visualizerCanvas.height - (interpolatedValue * visualizerCanvas.height * 1.2);
                p.targetY = spectrumY - 6; // Keep particles a bit higher than the curve

                p.update();
            });

            // Now, draw a smooth curve connecting the particles
            if (particles.length > 1) {
                visualizerCtx.beginPath();
                visualizerCtx.moveTo(particles[0].x, particles[0].y);

                // Draw segments to midpoints, which creates a smooth chain
                for (let i = 0; i < particles.length - 2; i++) {
                    const p1 = particles[i];
                    const p2 = particles[i + 1];
                    const xc = (p1.x + p2.x) / 2;
                    const yc = (p1.y + p2.y) / 2;
                    visualizerCtx.quadraticCurveTo(p1.x, p1.y, xc, yc);
                }

                // For the last segment, curve to the last point to make it smooth
                const secondLast = particles[particles.length - 2];
                const last = particles[particles.length - 1];
                visualizerCtx.quadraticCurveTo(secondLast.x, secondLast.y, last.x, last.y);


                const { r, g, b } = visualizerColor;
                visualizerCtx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.85)`;
                visualizerCtx.lineWidth = 1.5;
                visualizerCtx.lineJoin = 'round';
                visualizerCtx.lineCap = 'round';
                visualizerCtx.stroke();
            }

            animationFrameId = requestAnimationFrame(draw);
        };
        draw();
    };

    const drawVisualizer = (data) => {
        visualizerCtx.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);

        const bufferLength = data.length;
        if (bufferLength === 0) return;

        const gradient = visualizerCtx.createLinearGradient(0, 0, 0, visualizerCanvas.height);
        const { r, g, b } = visualizerColor;
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.85)`);
        gradient.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, 0.4)`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.05)`);

        visualizerCtx.fillStyle = gradient;
        visualizerCtx.strokeStyle = gradient;
        visualizerCtx.lineWidth = 2;

        visualizerCtx.beginPath();
        visualizerCtx.moveTo(0, visualizerCanvas.height);

        const sliceWidth = visualizerCanvas.width / (bufferLength - 1);

        // Helper to get a point's coordinates
        const getPoint = (index) => {
            const value = data[index] || 0;
            const x = index * sliceWidth;
            const y = visualizerCanvas.height - (value * visualizerCanvas.height * 1.2);
            return [x, y];
        };

        for (let i = 0; i < bufferLength - 1; i++) {
            const [x1, y1] = getPoint(i);
            const [x2, y2] = getPoint(i + 1);

            const [prev_x, prev_y] = i > 0 ? getPoint(i - 1) : [x1, y1];
            const [next_x, next_y] = i < bufferLength - 2 ? getPoint(i + 2) : [x2, y2];

            const tension = 0.5;
            const cp1_x = x1 + (x2 - prev_x) / 6 * tension;
            const cp1_y = y1 + (y2 - prev_y) / 6 * tension;
            const cp2_x = x2 - (next_x - x1) / 6 * tension;
            const cp2_y = y2 - (next_y - y1) / 6 * tension;

            if (i === 0) {
                visualizerCtx.lineTo(x1, y1);
            }

            visualizerCtx.bezierCurveTo(cp1_x, cp1_y, cp2_x, cp2_y, x2, y2);

            // --- Particle Generation ---
        }

        visualizerCtx.lineTo(visualizerCanvas.width, visualizerCanvas.height);
        visualizerCtx.closePath();
        visualizerCtx.fill();
    };

    // --- Event Listeners ---
    playPauseBtn.addEventListener('click', () => {
        isPlaying ? pauseTrack() : playTrack();
    });
    prevBtn.addEventListener('click', prevTrack);
    nextBtn.addEventListener('click', nextTrack);
    // --- Progress Bar Drag Logic ---
    let dragInProgress = false; // Use a different name to avoid conflict

    const handleProgressUpdate = async (e, shouldSeek = false) => {
        const rect = progressContainer.getBoundingClientRect();
        // Ensure offsetX is within valid bounds
        const offsetX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const width = rect.width;

        const result = await window.electron.invoke('music-get-state');
        if (result.status === 'success' && result.state.duration > 0) {
            const duration = result.state.duration;
            const newTime = (offsetX / width) * duration;

            // Update UI immediately
            progress.style.width = `${(newTime / duration) * 100}%`;
            currentTimeEl.textContent = formatTime(newTime);

            if (shouldSeek) {
                await window.electron.invoke('music-seek', newTime);
                // If still playing after drag, resume polling
                if (isPlaying) {
                    startStatePolling();
                }
            }
        }
    };

    progressContainer.addEventListener('mousedown', (e) => {
        dragInProgress = true;
        stopStatePolling(); // Pause state polling during drag to prevent UI jumps
        handleProgressUpdate(e);
    });

    window.addEventListener('mousemove', (e) => {
        if (dragInProgress) {
            handleProgressUpdate(e);
        }
    });

    window.addEventListener('mouseup', (e) => {
        if (dragInProgress) {
            handleProgressUpdate(e, true); // Pass true to seek
            // The click event will fire after mouseup, so we delay resetting the flag
            setTimeout(() => {
                dragInProgress = false;
            }, 0);
        }
    });

    progressContainer.addEventListener('click', (e) => {
        // Only seek on click if not dragging
        if (!dragInProgress) {
            handleProgressUpdate(e, true);
        }
    });

    const updateVolumeSliderBackground = (value) => {
        const percentage = value * 100;
        volumeSlider.style.backgroundSize = `${percentage}% 100%`;
    };

    // 音量控制暂时保持前端控制，因为它不影响HIFI解码
    volumeSlider.addEventListener('input', async (e) => {
        const newVolume = parseFloat(e.target.value);
        updateVolumeSliderBackground(newVolume);
        if (window.electron) {
            await window.electron.invoke('music-set-volume', newVolume);
        }
    });
    volumeBtn.addEventListener('click', () => {
        // Mute toggle logic can be implemented here if needed
        const isMuted = volumeSlider.value === '0';
        const newVolume = isMuted ? (volumeBtn.dataset.lastVolume || 1) : 0;

        if (!isMuted) {
            volumeBtn.dataset.lastVolume = volumeSlider.value;
        }

        volumeSlider.value = newVolume;
        // Manually trigger the input event to send the new volume to the engine
        volumeSlider.dispatchEvent(new Event('input'));
    });

    modeBtn.addEventListener('click', () => {
        currentPlayMode = (currentPlayMode + 1) % playModes.length;
        // Reset shuffle queue when switching to shuffle mode to ensure a fresh sequence
        if (playModes[currentPlayMode] === 'shuffle') {
            shuffleQueue = [];
        }
        updateModeButton();
        if (wnpAdapter) wnpAdapter.sendUpdate();
    });

    const updateModeButton = () => {
        modeBtn.className = 'control-btn icon-btn'; // Reset classes
        const currentMode = playModes[currentPlayMode];
        modeBtn.classList.add(currentMode);
        if (currentMode !== 'repeat') {
            modeBtn.classList.add('active');
        }
    };

    playlistEl.addEventListener('click', (e) => {
        if (e.target.tagName === 'LI') {
            const index = parseInt(e.target.dataset.index, 10);
            // Reset shuffle queue on manual selection to start a new sequence from this song
            shuffleQueue = [];
            loadTrack(index);
        }
    });

    searchInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase();
        const filteredPlaylist = playlist.filter(track =>
            (track.title || '').toLowerCase().includes(searchTerm) ||
            (track.artist || '').toLowerCase().includes(searchTerm) ||
            (track.album || '').toLowerCase().includes(searchTerm)
        );
        renderPlaylist(filteredPlaylist);
    });

    window.addEventListener('resize', () => {
        visualizerCanvas.width = visualizerCanvas.clientWidth;
        visualizerCanvas.height = visualizerCanvas.clientHeight;
        recreateParticles(); // Re-distribute particles on resize
    });

    shareBtn.addEventListener('click', () => {
        if (!playlist || playlist.length === 0 || !playlist[currentTrackIndex]) return;
        const track = playlist[currentTrackIndex];
        if (track.path && window.electron) {
            window.electron.send('share-file-to-main', track.path);
        }
    });

    // --- Custom Title Bar Listeners ---
    minimizeBtn.addEventListener('click', () => {
        if (window.electronAPI) window.electronAPI.minimizeWindow();
    });

    maximizeBtn.addEventListener('click', () => {
        if (window.electronAPI) window.electronAPI.maximizeWindow();
    });

    closeBtn.addEventListener('click', () => {
        window.close();
    });

    // --- WASAPI and Device Control ---
    const populateDeviceList = async (forceRefresh = false) => {
        if (!window.electron) return;
        try {
            const result = await window.electron.invoke('music-get-devices', { refresh: forceRefresh });
            if (result.status === 'success' && result.devices) {
                deviceSelect.innerHTML = ''; // Clear existing options

                // Add default device option
                const defaultOption = document.createElement('option');
                defaultOption.value = 'default';
                defaultOption.textContent = '默认设备';
                deviceSelect.appendChild(defaultOption);

                // Add Preferred devices (WASAPI or Core Audio)
                const preferredDevices = result.devices.preferred || [];
                const preferredName = result.devices.preferred_name || '推荐设备';

                if (preferredDevices.length > 0) {
                    const preferredGroup = document.createElement('optgroup');
                    preferredGroup.label = preferredName;
                    preferredDevices.forEach(device => {
                        const option = document.createElement('option');
                        option.value = device.id;
                        option.textContent = device.name;
                        preferredGroup.appendChild(option);
                    });
                    deviceSelect.appendChild(preferredGroup);
                }

                // Add Other devices
                const otherDevices = result.devices.other || [];
                if (otherDevices.length > 0) {
                    const otherGroup = document.createElement('optgroup');
                    otherGroup.label = '其他设备';
                    otherDevices.forEach(device => {
                        const option = document.createElement('option');
                        option.value = device.id;
                        option.textContent = device.name;
                        otherGroup.appendChild(option);
                    });
                    deviceSelect.appendChild(otherGroup);
                }
            } else {
                console.error("Failed to get audio devices:", result.message);
            }
        } catch (error) {
            console.error("Error populating device list:", error);
        }
    };

    const configureOutput = async () => {
        if (!window.electron) return;

        const selectedDeviceId = deviceSelect.value === 'default' ? null : parseInt(deviceSelect.value, 10);
        const useExclusive = wasapiSwitch.checked;

        // Prevent re-configuration if nothing changed
        if (selectedDeviceId === currentDeviceId && useExclusive === useWasapiExclusive) {
            return;
        }

        console.log(`Configuring output: Device ID=${selectedDeviceId}, Exclusive=${useExclusive}`);

        // 禁用选择框防止重复触发
        deviceSelect.disabled = true;
        wasapiSwitch.disabled = true;

        try {
            currentDeviceId = selectedDeviceId;
            useWasapiExclusive = useExclusive;

            await window.electron.invoke('music-configure-output', {
                device_id: currentDeviceId,
                exclusive: useWasapiExclusive
            });

            // 切换后重新获取设备列表，以更新“(系统默认)”标记
            await populateDeviceList(false);
            deviceSelect.value = currentDeviceId === null ? 'default' : currentDeviceId;
        } catch (error) {
            console.error("Error configuring output:", error);
        } finally {
            deviceSelect.disabled = false;
            wasapiSwitch.disabled = false;
        }
    };

    deviceSelect.addEventListener('change', configureOutput);
    wasapiSwitch.addEventListener('change', configureOutput);

    // --- Upsampling Control ---
    const configureUpsampling = async () => {
        if (!window.electron) return;
        const selectedRate = parseInt(upsamplingSelect.value, 10);

        if (selectedRate === targetUpsamplingRate) {
            return;
        }

        targetUpsamplingRate = selectedRate;

        console.log(`Configuring upsampling: Target Rate=${targetUpsamplingRate}`);
        await window.electron.invoke('music-configure-upsampling', {
            target_samplerate: targetUpsamplingRate > 0 ? targetUpsamplingRate : null
        });
    };

    upsamplingSelect.addEventListener('change', configureUpsampling);

    // --- EQ Control ---
    const populateEqPresets = () => {
        const presetNames = {
            'balance': '平衡',
            'classical': '古典',
            'pop': '流行',
            'rock': '摇滚',
            'electronic': '电子',
            'acg_vocal': '萌系ACG'
        };
        for (const preset in eqPresets) {
            const option = document.createElement('option');
            option.value = preset;
            option.textContent = presetNames[preset] || preset;
            eqPresetSelect.appendChild(option);
        }
    };

    const applyEqPreset = (presetName) => {
        const preset = eqPresets[presetName];
        if (!preset) return;

        for (const band in preset) {
            const slider = document.getElementById(`eq-${band}`);
            if (slider) {
                slider.value = preset[band];
            }
        }
        sendEqSettings();
    };

    const createEqBands = () => {
        eqBandsContainer.innerHTML = '';
        for (const band in eqBands) {
            const bandContainer = document.createElement('div');
            bandContainer.className = 'eq-band';

            const label = document.createElement('label');
            label.setAttribute('for', `eq-${band}`);
            label.textContent = band;

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.id = `eq-${band}`;
            slider.min = -15;
            slider.max = 15;
            slider.step = 1;
            slider.value = eqBands[band];

            slider.addEventListener('input', () => sendEqSettings());

            bandContainer.appendChild(label);
            bandContainer.appendChild(slider);
            eqBandsContainer.appendChild(bandContainer);
        }
    };

    const sendEqSettings = async () => {
        if (!window.electron) return;

        const newBands = {};
        for (const band in eqBands) {
            const slider = document.getElementById(`eq-${band}`);
            newBands[band] = parseInt(slider.value, 10);
        }

        eqEnabled = eqSwitch.checked;

        await window.electron.invoke('music-set-eq', {
            bands: newBands,
            enabled: eqEnabled
        });
    };

    eqSwitch.addEventListener('change', () => {
        eqSection.classList.toggle('expanded', eqSwitch.checked);
        sendEqSettings();
    });

    eqTypeSelect.addEventListener('change', async () => {
        if (!window.electron) return;
        const result = await window.electron.invoke('music-set-eq-type', { type: eqTypeSelect.value });
        if (result.status === 'success') {
            updateUIWithState(result.state);
        }
    });

    const updateOptimizations = async () => {
        if (!window.electron) return;
        await window.electron.invoke('music-configure-optimizations', {
            dither_enabled: ditherSwitch.checked,
            replaygain_enabled: replaygainSwitch.checked
        });
    };

    ditherSwitch.addEventListener('change', updateOptimizations);
    replaygainSwitch.addEventListener('change', updateOptimizations);

    eqPresetSelect.addEventListener('change', (e) => {
        applyEqPreset(e.target.value);
    });

    // --- Electron IPC and Initialization ---
    const setupElectronHandlers = () => {
        if (!window.electron) return;

        addFolderBtn.addEventListener('click', () => {
            loadingIndicator.style.display = 'flex';
            scanProgressContainer.style.display = 'none';
            scanProgressBar.style.width = '0%';
            scanProgressLabel.textContent = '';
            window.electron.send('open-music-folder');
        });

        let totalFilesToScan = 0, filesScanned = 0;
        window.electron.on('scan-started', ({ total }) => {
            totalFilesToScan = total;
            filesScanned = 0;
            scanProgressContainer.style.display = 'block';
            scanProgressLabel.textContent = `0 / ${totalFilesToScan}`;
        });

        window.electron.on('scan-progress', () => {
            filesScanned++;
            const percentage = totalFilesToScan > 0 ? (filesScanned / totalFilesToScan) * 100 : 0;
            scanProgressBar.style.width = `${percentage}%`;
            scanProgressLabel.textContent = `${filesScanned} / ${totalFilesToScan}`;
        });

        window.electron.on('scan-finished', (newlyScannedFiles) => {
            loadingIndicator.style.display = 'none';
            // Only update playlist if new files were actually scanned.
            // This prevents clearing the list if the user cancels the folder selection.
            if (newlyScannedFiles && newlyScannedFiles.length > 0) {
                playlist = newlyScannedFiles;
                renderPlaylist();
                window.electron.send('save-music-playlist', playlist);
                if (playlist.length > 0) {
                    loadTrack(0, false); // Load first track but don't play
                }
            }
            // If newlyScannedFiles is empty or null, do nothing, preserving the old playlist.
        });

        // Listen for errors from the main process (e.g., engine connection failed)
        window.electron.on('audio-engine-error', ({ message }) => {
            console.error("Received error from main process:", message);
            // You can display this error to the user, e.g., in a toast notification
        });

        // Listen for track changes from the main process (e.g., from AI control)
        window.electron.on('music-set-track', (track) => {
            if (!playlist.some(t => t.path === track.path)) {
                playlist.unshift(track); // Add to playlist if not already there
            }
            const trackIndex = playlist.findIndex(t => t.path === track.path);
            if (trackIndex !== -1) {
                shuffleQueue = []; // Reset shuffle on external track change
                loadTrack(trackIndex, true); // Load and play the track
            }
        });
    };

    const renderPlaylist = (filteredPlaylist) => {
        const songsToRender = filteredPlaylist || playlist;
        playlistEl.innerHTML = '';
        const fragment = document.createDocumentFragment();
        songsToRender.forEach((track) => {
            const li = document.createElement('li');
            li.textContent = track.title || '未知标题';
            const originalIndex = playlist.indexOf(track);
            li.dataset.index = originalIndex;
            if (originalIndex === currentTrackIndex) {
                li.classList.add('active');
            }
            fragment.appendChild(li);
        });
        playlistEl.appendChild(fragment);
    };

    // --- Lyrics Handling ---
    const fetchAndDisplayLyrics = async (artist, title) => {
        resetLyrics();
        if (!window.electron) return;

        const lrcContent = await window.electron.invoke('music-get-lyrics', { artist, title });

        if (lrcContent) {
            currentLyrics = parseLrc(lrcContent);
            renderLyrics();
        } else {
            // If no local lyrics, try fetching from network
            lyricsList.innerHTML = '<li class="no-lyrics">正在网络上搜索歌词...</li>';
            try {
                const fetchedLrc = await window.electron.invoke('music-fetch-lyrics', { artist, title });
                if (fetchedLrc) {
                    currentLyrics = parseLrc(fetchedLrc);
                    renderLyrics();
                } else {
                    lyricsList.innerHTML = '<li class="no-lyrics">暂无歌词</li>';
                }
            } catch (error) {
                console.error('Failed to fetch lyrics from network:', error);
                lyricsList.innerHTML = '<li class="no-lyrics">歌词获取失败</li>';
            }
        }
    };

    const parseLrc = (lrcContent) => {
        const lyricsMap = new Map();
        const lines = lrcContent.split('\n');
        const timeRegex = /\[(\d{2}):(\d{2})[.:](\d{2,3})\]/g;

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            const text = trimmedLine.replace(timeRegex, '').trim();
            if (text) {
                let match;
                timeRegex.lastIndex = 0;
                while ((match = timeRegex.exec(trimmedLine)) !== null) {
                    const minutes = parseInt(match[1], 10);
                    const seconds = parseInt(match[2], 10);
                    const milliseconds = parseInt(match[3].padEnd(3, '0'), 10);
                    const time = (minutes * 60 + seconds + milliseconds / 1000) * lyricSpeedFactor + lyricOffset;

                    const timeKey = time.toFixed(4); // Use fixed precision for map key

                    if (lyricsMap.has(timeKey)) {
                        // This is likely the translation, append it.
                        // This simple logic assumes original text comes before translation for the same timestamp.
                        if (!lyricsMap.get(timeKey).translation) {
                            lyricsMap.get(timeKey).translation = text;
                        }
                    } else {
                        // This is the original lyric
                        lyricsMap.set(timeKey, { time, original: text, translation: '' });
                    }
                }
            }
        }

        return Array.from(lyricsMap.values()).sort((a, b) => a.time - b.time);
    };

    const renderLyrics = () => {
        lyricsList.innerHTML = '';
        const fragment = document.createDocumentFragment();
        currentLyrics.forEach((line, index) => {
            const li = document.createElement('li');

            const originalSpan = document.createElement('span');
            originalSpan.textContent = line.original;
            originalSpan.className = 'lyric-original';
            li.appendChild(originalSpan);

            if (line.translation) {
                const translationSpan = document.createElement('span');
                translationSpan.textContent = line.translation;
                translationSpan.className = 'lyric-translation';
                li.appendChild(translationSpan);
            }

            li.dataset.index = index;
            fragment.appendChild(li);
        });
        lyricsList.appendChild(fragment);
    };

    const animateLyrics = () => {
        if (currentLyrics.length === 0 || !isPlaying) return;

        // Re-introduce client-side time estimation for smooth scrolling, anchored by backend state.
        const elapsedTime = (Date.now() - lastStateUpdateTime) / 1000;
        const estimatedTime = lastKnownCurrentTime + elapsedTime;

        let newLyricIndex = -1;
        for (let i = 0; i < currentLyrics.length; i++) {
            if (estimatedTime >= currentLyrics[i].time) {
                newLyricIndex = i;
            } else {
                break;
            }
        }

        if (newLyricIndex !== currentLyricIndex) {
            currentLyricIndex = newLyricIndex;
        }

        // Update visual styles (like opacity) on every frame for smoothness.
        const allLi = lyricsList.querySelectorAll('li');
        allLi.forEach((li, index) => {
            const distance = Math.abs(index - currentLyricIndex);

            if (index === currentLyricIndex) {
                li.classList.add('active');
                li.style.opacity = 1;
            } else {
                li.classList.remove('active');
                li.style.opacity = Math.max(0.1, 1 - distance * 0.22).toFixed(2);
            }
        });

        // Smooth scrolling logic
        if (currentLyricIndex > -1) {
            const currentLine = currentLyrics[currentLyricIndex];
            const nextLine = currentLyrics[currentLyricIndex + 1];

            const currentLineLi = lyricsList.querySelector(`li[data-index='${currentLyricIndex}']`);
            if (!currentLineLi) return;

            let progress = 0;
            if (nextLine) {
                const timeIntoLine = estimatedTime - currentLine.time;
                const lineDuration = nextLine.time - currentLine.time;
                if (lineDuration > 0) {
                    progress = Math.max(0, Math.min(1, timeIntoLine / lineDuration));
                }
            }

            const nextLineLi = nextLine ? lyricsList.querySelector(`li[data-index='${currentLyricIndex + 1}']`) : null;
            const currentOffset = currentLineLi.offsetTop;
            const nextOffset = nextLineLi ? nextLineLi.offsetTop : currentOffset;

            const interpolatedOffset = currentOffset + (nextOffset - currentOffset) * progress;

            const goldenRatioPoint = lyricsContainer.clientHeight * 0.382;
            const scrollOffset = interpolatedOffset - goldenRatioPoint + (currentLineLi.clientHeight / 2);

            lyricsList.style.transform = `translateY(-${scrollOffset}px)`;
        }
    };

    const resetLyrics = () => {
        currentLyrics = [];
        currentLyricIndex = -1;
        lyricsList.innerHTML = '<li class="no-lyrics">加载歌词中...</li>';
        lyricsList.style.transform = 'translateY(0px)';
    };

    // --- Theme Handling ---
    const applyTheme = (theme) => {
        currentTheme = theme;
        document.body.classList.toggle('light-theme', theme === 'light');
        // Use requestAnimationFrame to wait for the styles to be applied
        requestAnimationFrame(() => {
            // A second frame might be needed for variables to be fully available
            requestAnimationFrame(() => {
                const highlightColor = getComputedStyle(document.body).getPropertyValue('--music-highlight');
                const rgbColor = hexToRgb(highlightColor);
                if (rgbColor) {
                    visualizerColor = rgbColor;
                }
                // Also re-apply volume slider background as it depends on a theme variable
                updateVolumeSliderBackground(volumeSlider.value);
            });
        });
        const currentArt = albumArt.style.backgroundImage;
        if (!currentArt || currentArt.includes('musicdark.jpeg') || currentArt.includes('musiclight.jpeg')) {
            const defaultArtUrl = `url('../assets/${theme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
            albumArt.style.backgroundImage = defaultArtUrl;
            updateBlurredBackground(defaultArtUrl);
        }
    };

    const initializeTheme = async () => {
        if (window.electronAPI) {
            // Use the new robust theme listener
            window.electronAPI.onThemeUpdated(applyTheme);
            try {
                const theme = await window.electronAPI.getCurrentTheme();
                applyTheme(theme || 'dark');
            } catch (error) {
                console.error('Failed to initialize theme:', error);
                applyTheme('dark');
            }
        } else {
            applyTheme('dark'); // Fallback for non-electron env
        }
    };

    // --- Phantom Audio Generation ---
    const createSilentAudio = () => {
        const context = new (window.AudioContext || window.webkitAudioContext)();
        const sampleRate = 44100;
        const duration = 60; // 60秒足够，且不会导致启动卡顿
        const frameCount = sampleRate * duration;
        const buffer = context.createBuffer(1, frameCount, sampleRate);
        // The buffer is already filled with zeros (silence)

        // Convert buffer to WAV
        const getWav = (buffer) => {
            const numChannels = buffer.numberOfChannels;
            const sampleRate = buffer.sampleRate;
            const format = 1; // PCM
            const bitDepth = 16;
            const blockAlign = numChannels * bitDepth / 8;
            const byteRate = sampleRate * blockAlign;
            const dataSize = buffer.length * numChannels * bitDepth / 8;
            const bufferSize = 44 + dataSize;

            const view = new DataView(new ArrayBuffer(bufferSize));
            let offset = 0;

            const writeString = (str) => {
                for (let i = 0; i < str.length; i++) {
                    view.setUint8(offset++, str.charCodeAt(i));
                }
            };

            writeString('RIFF');
            view.setUint32(offset, 36 + dataSize, true); offset += 4;
            writeString('WAVE');
            writeString('fmt ');
            view.setUint32(offset, 16, true); offset += 4;
            view.setUint16(offset, format, true); offset += 2;
            view.setUint16(offset, numChannels, true); offset += 2;
            view.setUint32(offset, sampleRate, true); offset += 4;
            view.setUint32(offset, byteRate, true); offset += 4;
            view.setUint16(offset, blockAlign, true); offset += 2;
            view.setUint16(offset, bitDepth, true); offset += 2;
            writeString('data');
            view.setUint32(offset, dataSize, true); offset += 4;

            const pcm = new Int16Array(buffer.length);
            // Buffer is already silent, no need to loop and fill from channelData
            for (let i = 0; i < pcm.length; i++, offset += 2) {
                view.setInt16(offset, pcm[i], true);
            }

            return view.buffer;
        };

        const wavBuffer = getWav(buffer);
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        return URL.createObjectURL(blob);
    };

    // ===== SIDEBAR FUNCTIONALITY =====

    // --- Custom Playlist Persistence ---
    const loadCustomPlaylists = async () => {
        if (window.electron) {
            customPlaylists = await window.electron.invoke('get-custom-playlists') || [];
        }
    };

    const saveCustomPlaylists = () => {
        if (window.electron) {
            window.electron.send('save-custom-playlists', customPlaylists);
        }
    };

    // --- Grouping Functions ---
    const getAlbumGroups = () => {
        const albums = {};
        playlist.forEach(track => {
            const albumName = track.album || '未知专辑';
            if (!albums[albumName]) {
                albums[albumName] = { name: albumName, art: track.albumArt, tracks: [] };
            }
            albums[albumName].tracks.push(track);
        });
        return Object.values(albums).sort((a, b) => b.tracks.length - a.tracks.length);
    };

    const getArtistGroups = () => {
        const artists = {};
        playlist.forEach(track => {
            const artistName = track.artist || '未知艺术家';
            if (!artists[artistName]) {
                artists[artistName] = { name: artistName, art: track.albumArt, tracks: [] };
            }
            artists[artistName].tracks.push(track);
        });
        return Object.values(artists).sort((a, b) => b.tracks.length - a.tracks.length);
    };

    // --- Sidebar Rendering ---
    const renderSidebarContent = (view) => {
        currentSidebarView = view;
        sidebarFooter.style.display = view === 'playlists' ? 'block' : 'none';

        if (view === 'all') {
            filteredPlaylistSource = null;
            currentFilteredTracks = null;
            sidebarContent.innerHTML = `
                <div class="sidebar-stats">
                    <span class="stat-number">${playlist.length}</span>
                    首歌曲
                </div>
            `;
            renderPlaylist();
        } else if (view === 'albums') {
            const albums = getAlbumGroups();
            sidebarContent.innerHTML = '';
            albums.forEach(album => {
                const div = document.createElement('div');
                div.className = 'category-item';
                div.innerHTML = `
                    <div class="cover" style="${album.art ? `background-image: url('file://${album.art.replace(/\\/g, '/')}')` : ''}"></div>
                    <div class="info">
                        <div class="name">${album.name}</div>
                        <div class="count">${album.tracks.length} 首</div>
                    </div>
                `;
                div.addEventListener('click', () => {
                    filteredPlaylistSource = { type: 'album', name: album.name };
                    currentFilteredTracks = album.tracks;
                    renderPlaylist(album.tracks);
                    document.querySelectorAll('.category-item').forEach(el => el.classList.remove('active'));
                    div.classList.add('active');
                });
                sidebarContent.appendChild(div);
            });
        } else if (view === 'artists') {
            const artists = getArtistGroups();
            sidebarContent.innerHTML = '';
            artists.forEach(artist => {
                const div = document.createElement('div');
                div.className = 'category-item';
                div.innerHTML = `
                    <div class="cover artist-avatar" style="${artist.art ? `background-image: url('file://${artist.art.replace(/\\/g, '/')}')` : ''}"></div>
                    <div class="info">
                        <div class="name">${artist.name}</div>
                        <div class="count">${artist.tracks.length} 首</div>
                    </div>
                `;
                div.addEventListener('click', () => {
                    filteredPlaylistSource = { type: 'artist', name: artist.name };
                    currentFilteredTracks = artist.tracks;
                    renderPlaylist(artist.tracks);
                    document.querySelectorAll('.category-item').forEach(el => el.classList.remove('active'));
                    div.classList.add('active');
                });
                sidebarContent.appendChild(div);
            });
        } else if (view === 'playlists') {
            sidebarContent.innerHTML = '';
            customPlaylists.forEach(pl => {
                const div = document.createElement('div');
                div.className = 'category-item';
                div.innerHTML = `
                    <div class="cover" style="display:flex;align-items:center;justify-content:center;font-size:1.2em;">📁</div>
                    <div class="info">
                        <div class="name">${pl.name}</div>
                        <div class="count">${pl.tracks.length} 首</div>
                    </div>
                    <button class="edit-btn" title="编辑歌单">✎</button>
                    <button class="delete-btn" title="删除歌单">✕</button>
                `;
                div.querySelector('.edit-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    openPlaylistEditModal(pl.id);
                });
                div.querySelector('.delete-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (confirm(`确定删除歌单 "${pl.name}" 吗？`)) {
                        customPlaylists = customPlaylists.filter(p => p.id !== pl.id);
                        saveCustomPlaylists();
                        renderSidebarContent('playlists');
                    }
                });
                div.addEventListener('click', () => {
                    filteredPlaylistSource = { type: 'playlist', name: pl.name, id: pl.id };
                    const tracks = pl.tracks.map(path => playlist.find(t => t.path === path)).filter(Boolean);
                    currentFilteredTracks = tracks;
                    renderPlaylist(tracks);
                    document.querySelectorAll('.category-item').forEach(el => el.classList.remove('active'));
                    div.classList.add('active');
                });
                sidebarContent.appendChild(div);
            });
            if (customPlaylists.length === 0) {
                sidebarContent.innerHTML = '<div class="sidebar-stats">暂无歌单<br>点击下方按钮创建</div>';
            }
        }
    };

    // --- Sidebar Tab Events ---
    const setupSidebarTabs = () => {
        sidebarTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                sidebarTabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                renderSidebarContent(tab.dataset.view);
            });
        });
    };

    // --- Dialog Functions ---
    const showPlaylistDialog = (callback) => {
        pendingAddToPlaylist = callback;
        playlistNameInput.value = '';
        playlistDialog.classList.add('visible');
        playlistNameInput.focus();
    };

    const hidePlaylistDialog = () => {
        playlistDialog.classList.remove('visible');
        pendingAddToPlaylist = null;
    };

    const createNewPlaylist = (name) => {
        const newPlaylist = { id: Date.now(), name, tracks: [] };
        customPlaylists.push(newPlaylist);
        saveCustomPlaylists();
        return newPlaylist;
    };

    // --- Context Menu Functions ---
    const showContextMenu = (x, y) => {
        // Update submenu with playlists
        updatePlaylistSubmenu();

        // Position menu
        contextMenu.style.left = `${x}px`;
        contextMenu.style.top = `${y}px`;
        contextMenu.classList.add('visible');

        // Adjust if off screen
        requestAnimationFrame(() => {
            const rect = contextMenu.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                contextMenu.style.left = `${window.innerWidth - rect.width - 10}px`;
            }
            if (rect.bottom > window.innerHeight) {
                contextMenu.style.top = `${window.innerHeight - rect.height - 10}px`;
            }
        });
    };

    const hideContextMenu = () => {
        contextMenu.classList.remove('visible');
    };

    const updatePlaylistSubmenu = () => {
        if (customPlaylists.length === 0) {
            playlistSubmenu.innerHTML = '<div class="submenu-empty">暂无歌单</div>';
        } else {
            playlistSubmenu.innerHTML = '';
            customPlaylists.forEach(pl => {
                const item = document.createElement('div');
                item.className = 'submenu-item';
                item.textContent = pl.name;
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    addSelectedTracksToPlaylist(pl.id);
                    hideContextMenu();
                });
                playlistSubmenu.appendChild(item);
            });
        }
    };
    const addSelectedTracksToPlaylist = (playlistId) => {
        const pl = customPlaylists.find(p => p.id === playlistId);
        if (!pl || contextMenuTrackIndex === null) return;

        const track = playlist[contextMenuTrackIndex];
        if (!track) return;

        if (pl.tracks.includes(track.path)) {
            alert(`歌曲 "${track.title || '未知标题'}" 已在歌单 "${pl.name}" 中`);
            return;
        }

        pl.tracks.push(track.path);
        saveCustomPlaylists();
        
        // 如果当前正在查看该歌单，则刷新显示
        if (filteredPlaylistSource?.type === 'playlist' && filteredPlaylistSource.id === playlistId) {
            const tracks = pl.tracks.map(path => playlist.find(t => t.path === path)).filter(Boolean);
            renderPlaylist(tracks);
        }
        
        // 刷新侧边栏以更新歌曲计数
        if (currentSidebarView === 'playlists') {
            renderSidebarContent('playlists');
        }
    };


    // ===== PLAYLIST EDIT MODAL FUNCTIONS =====

    // --- Open Modal ---
    const openPlaylistEditModal = (playlistId) => {
        const pl = customPlaylists.find(p => p.id === playlistId);
        if (!pl) return;

        editingPlaylistId = playlistId;
        modalSearchQuery = '';
        lastModalClickIndex = -1; // Reset for shift-select
        modalSearchInput.value = '';
        modalPlaylistTitle.textContent = `编辑: ${pl.name}`;
        renderModalSongList();
        playlistEditModal.classList.add('visible');
    };

    // --- Close Modal ---
    const closePlaylistEditModal = () => {
        playlistEditModal.classList.remove('visible');
        editingPlaylistId = null;
        // Refresh sidebar if we're on playlists view
        if (currentSidebarView === 'playlists') {
            renderSidebarContent('playlists');
        }
    };

    // --- Render Songs in Modal ---
    const renderModalSongList = () => {
        const pl = customPlaylists.find(p => p.id === editingPlaylistId);
        if (!pl) return;

        // Filter by search query
        const query = modalSearchQuery.toLowerCase();
        const filteredTracks = query
            ? playlist.filter(t =>
                (t.title || '').toLowerCase().includes(query) ||
                (t.artist || '').toLowerCase().includes(query) ||
                (t.album || '').toLowerCase().includes(query)
            )
            : playlist;

        if (filteredTracks.length === 0) {
            modalSongList.innerHTML = '<div class="music-modal-empty">没有匹配的歌曲</div>';
            modalCount.textContent = `${pl.tracks.length} 首已添加`;
            return;
        }

        modalSongList.innerHTML = '';
        const fragment = document.createDocumentFragment();

        filteredTracks.forEach((track, index) => {
            const isInPlaylist = pl.tracks.includes(track.path);
            const div = document.createElement('div');
            div.className = `music-modal-song-item${isInPlaylist ? ' in-playlist' : ''}`;
            div.dataset.path = track.path;
            div.dataset.index = index;
            div.innerHTML = `
                <div class="music-modal-song-checkbox">
                    <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg>
                </div>
                <div class="music-modal-song-info">
                    <div class="music-modal-song-title">${track.title || '未知标题'}</div>
                    <div class="music-modal-song-artist">${track.artist || '未知艺术家'}</div>
                </div>
            `;
            div.addEventListener('click', (e) => {
                const clickedIndex = parseInt(div.dataset.index, 10);

                if (e.shiftKey && lastModalClickIndex !== -1 && lastModalClickIndex !== clickedIndex) {
                    // Shift-click: toggle range
                    const start = Math.min(lastModalClickIndex, clickedIndex);
                    const end = Math.max(lastModalClickIndex, clickedIndex);
                    for (let i = start; i <= end; i++) {
                        const targetPath = filteredTracks[i].path;
                        // Check target state based on clicked item's desired state
                        const targetIsIn = pl.tracks.includes(targetPath);
                        const clickedIsIn = pl.tracks.includes(track.path);
                        // If clicked item will be added, add all; if removed, remove all
                        if (!clickedIsIn && !targetIsIn) {
                            pl.tracks.push(targetPath);
                        } else if (clickedIsIn && targetIsIn) {
                            const idx = pl.tracks.indexOf(targetPath);
                            if (idx !== -1) pl.tracks.splice(idx, 1);
                        }
                    }
                    saveCustomPlaylists();
                    renderModalSongList(); // Re-render to update all checkboxes
                } else {
                    toggleSongInPlaylist(track.path);
                }
                lastModalClickIndex = clickedIndex;
            });
            fragment.appendChild(div);
        });

        modalSongList.appendChild(fragment);
        modalCount.textContent = `${pl.tracks.length} 首已添加`;
    };

    // --- Toggle Song in Playlist ---
    const toggleSongInPlaylist = (trackPath) => {
        const pl = customPlaylists.find(p => p.id === editingPlaylistId);
        if (!pl) return;

        const index = pl.tracks.indexOf(trackPath);
        if (index === -1) {
            pl.tracks.push(trackPath);
        } else {
            pl.tracks.splice(index, 1);
        }
        saveCustomPlaylists();

        // Update UI
        const item = modalSongList.querySelector(`[data-path="${CSS.escape(trackPath)}"]`);
        if (item) {
            item.classList.toggle('in-playlist', index === -1);
        }
        modalCount.textContent = `${pl.tracks.length} 首已添加`;
    };

    // --- Setup Modal Handlers ---
    const setupModalHandlers = () => {
        modalCloseBtn?.addEventListener('click', closePlaylistEditModal);
        modalDoneBtn?.addEventListener('click', closePlaylistEditModal);

        // Close on backdrop click
        playlistEditModal?.addEventListener('click', (e) => {
            if (e.target === playlistEditModal) {
                closePlaylistEditModal();
            }
        });

        // Search
        modalSearchInput?.addEventListener('input', (e) => {
            modalSearchQuery = e.target.value;
            renderModalSongList();
        });

        // ESC to close
        playlistEditModal?.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closePlaylistEditModal();
            }
        });
    };

    // --- Simplified Context Menu (for single track) ---
    let contextMenuTrackIndex = null;

    const setupContextMenuHandlers = () => {
        // Right-click on playlist items
        playlistEl.addEventListener('contextmenu', (e) => {
            const li = e.target.closest('li');
            if (li && li.dataset.index !== undefined) {
                e.preventDefault();
                contextMenuTrackIndex = parseInt(li.dataset.index, 10);
                updatePlaylistSubmenu();
                showContextMenu(e.clientX, e.clientY);
            }
        });

        // Hide context menu on click outside
        document.addEventListener('click', (e) => {
            if (!contextMenu.contains(e.target)) {
                hideContextMenu();
            }
        });

        // Context menu actions
        contextMenu.addEventListener('click', (e) => {
            const item = e.target.closest('.context-menu-item');
            if (!item) return;

            const action = item.dataset.action;
            if (!action) return;

            // Capture the index immediately to avoid issues with async callbacks
            const trackIndex = contextMenuTrackIndex;

            switch (action) {
                case 'play':
                    if (trackIndex !== null) {
                        shuffleQueue = []; // Reset shuffle on manual selection
                        loadTrack(trackIndex);
                    }
                    break;
                case 'play-next':
                    console.log('Play next - queue feature');
                    break;
                case 'create-playlist-add':
                    showPlaylistDialog((newPlaylist) => {
                        const track = playlist[trackIndex];
                        if (track && !newPlaylist.tracks.includes(track.path)) {
                            newPlaylist.tracks.push(track.path);
                            saveCustomPlaylists();
                        }
                    });
                    break;
                case 'remove-from-list':
                    if (filteredPlaylistSource?.type === 'playlist') {
                        const pl = customPlaylists.find(p => p.id === filteredPlaylistSource.id);
                        const track = playlist[trackIndex];
                        if (pl && track) {
                            pl.tracks = pl.tracks.filter(path => path !== track.path);
                            saveCustomPlaylists();
                            const tracks = pl.tracks.map(path => playlist.find(t => t.path === path)).filter(Boolean);
                            renderPlaylist(tracks);
                        }
                    }
                    break;
            }
            hideContextMenu();
            contextMenuTrackIndex = null;
        });
    };

    // --- Dialog Event Handlers ---
    const setupDialogHandlers = () => {
        createPlaylistBtn?.addEventListener('click', () => {
            showPlaylistDialog();
        });

        dialogCancel?.addEventListener('click', hidePlaylistDialog);

        dialogConfirm?.addEventListener('click', () => {
            const name = playlistNameInput.value.trim();
            if (name) {
                const newPlaylist = createNewPlaylist(name);
                if (pendingAddToPlaylist) {
                    pendingAddToPlaylist(newPlaylist);
                }
                hidePlaylistDialog();
                if (currentSidebarView === 'playlists') {
                    renderSidebarContent('playlists');
                }
            }
        });

        playlistNameInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                dialogConfirm?.click();
            } else if (e.key === 'Escape') {
                hidePlaylistDialog();
            }
        });

        playlistDialog?.addEventListener('click', (e) => {
            if (e.target === playlistDialog) {
                hidePlaylistDialog();
            }
        });
    };

    // --- Initialize Sidebar ---
    const initSidebar = async () => {
        await loadCustomPlaylists();
        setupSidebarTabs();
        setupContextMenuHandlers();
        setupDialogHandlers();
        setupModalHandlers();
        renderSidebarContent('all');
    };

    // --- App Initialization ---
    const init = async () => {
        if (window.electron) {
            window.electron.send('music-renderer-ready');
        }
        visualizerCanvas.width = visualizerCanvas.clientWidth;
        visualizerCanvas.height = visualizerCanvas.clientHeight;

        // --- Initialize Particles ---
        recreateParticles();


        setupElectronHandlers();
        setupMediaSessionHandlers(); // Setup OS media controls
        updateModeButton();
        await initializeTheme();

        // Setup phantom audio
        try {
            phantomAudio.src = createSilentAudio();
        } catch (e) {
            console.error("Failed to create silent audio:", e);
        }

        // Initialize WebNowPlaying Adapter for Rainmeter
        wnpAdapter = new WebNowPlayingAdapter();

        if (window.electron) {
            const savedPlaylist = await window.electron.invoke('get-music-playlist');
            if (savedPlaylist && savedPlaylist.length > 0) {
                playlist = savedPlaylist;
                renderPlaylist();
                await loadTrack(0, false); // Wait for the track to load
            }
            // Initialize sidebar after playlist is loaded
            await initSidebar();
            // Sync initial volume
            const initialState = await window.electron.invoke('music-get-state');
            if (initialState && initialState.state && initialState.state.volume !== undefined) {
                volumeSlider.value = initialState.state.volume;
                updateVolumeSliderBackground(initialState.state.volume);
            }
        }

        // --- New: Populate devices and set initial state ---
        // 刷新页面后，直接获取设备列表，不再强制重新扫描以避免启动卡顿
        populateDeviceList(false);
        createEqBands(); // Create EQ sliders
        populateEqPresets(); // Populate EQ presets
        window.electron.invoke('music-get-state').then(initialDeviceState => {
            if (initialDeviceState && initialDeviceState.state) {
                currentDeviceId = initialDeviceState.state.device_id;
                useWasapiExclusive = initialDeviceState.state.exclusive_mode;
                deviceSelect.value = currentDeviceId === null ? 'default' : currentDeviceId;
                wasapiSwitch.checked = useWasapiExclusive;

                // Set initial EQ state from engine
                if (initialDeviceState.state.eq_enabled !== undefined) {
                    eqEnabled = initialDeviceState.state.eq_enabled;
                    eqSwitch.checked = eqEnabled;
                    eqSection.classList.toggle('expanded', eqEnabled);
                }
                if (initialDeviceState.state.eq_type !== undefined) {
                    eqTypeSelect.value = initialDeviceState.state.eq_type;
                }
                if (initialDeviceState.state.dither_enabled !== undefined) {
                    ditherSwitch.checked = initialDeviceState.state.dither_enabled;
                }
                if (initialDeviceState.state.replaygain_enabled !== undefined) {
                    replaygainSwitch.checked = initialDeviceState.state.replaygain_enabled;
                }
                if (initialDeviceState.state.eq_bands) {
                    for (const [band, gain] of Object.entries(initialDeviceState.state.eq_bands)) {
                        const slider = document.getElementById(`eq-${band}`);
                        if (slider) {
                            slider.value = gain;
                        }
                        eqBands[band] = gain;
                    }
                }
                // Set initial upsampling state
                if (initialDeviceState.state.target_samplerate !== undefined) {
                    targetUpsamplingRate = initialDeviceState.state.target_samplerate || 0;
                    upsamplingSelect.value = targetUpsamplingRate;
                }
            }
        });
    };

    init();
});
