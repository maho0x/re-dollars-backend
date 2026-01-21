import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export interface VideoProcessingOptions {
    quality?: 'low' | 'medium' | 'high';
    maxWidth?: number;
    maxHeight?: number;
    format?: 'mp4' | 'webm';
    codec?: 'h264' | 'hevc' | 'av1' | 'vp9';
    audioBitrate?: string;
    videoBitrate?: string;
    twoPass?: boolean;
}

export interface VideoProcessingResult {
    status: boolean;
    originalPath?: string;
    processedPath?: string;
    originalSize?: number;
    processedSize?: number;
    compressionRatio?: number;
    duration?: number;
    width?: number;
    height?: number;
    error?: string;
    processTime?: number;
}

export class VideoProcessingService {
    // 激进的现代化编码器质量预设 - 极致压缩率优化
    private static readonly QUALITY_PRESETS = {
        low: {
            videoBitrate: '300k',
            audioBitrate: '48k',
            maxWidth: 720,
            maxHeight: 480,
            crf: {
                h264: 30,
                hevc: 33,  // 更激进的 CRF
                av1: 40,   // AV1 极致压缩
                vp9: 38
            }
        },
        medium: {
            videoBitrate: '600k',
            audioBitrate: '64k',
            maxWidth: 1280,
            maxHeight: 720,
            crf: {
                h264: 26,
                hevc: 30,
                av1: 35,   // 激进但保持可接受质量
                vp9: 34
            }
        },
        high: {
            videoBitrate: '1000k',
            audioBitrate: '96k',
            maxWidth: 1920,
            maxHeight: 1080,
            crf: {
                h264: 23,
                hevc: 27,
                av1: 32,   // 高质量但仍然激进压缩
                vp9: 31
            }
        }
    };

    // 编码器配置 - 激进压缩优化
    private static readonly CODEC_CONFIG = {
        h264: {
            videoCodec: 'libx264',
            audioCodec: 'aac',
            container: 'mp4',
            preset: 'veryslow',  // 最慢但压缩率最高
            extraArgs: ['-movflags', '+faststart', '-tune', 'film']
        },
        hevc: {
            videoCodec: 'libx265',
            audioCodec: 'aac',
            container: 'mp4',
            preset: 'veryslow',  // 最慢但压缩率最高
            extraArgs: ['-movflags', '+faststart', '-tag:v', 'hvc1', '-x265-params', 'log-level=error:aq-mode=3:psy-rd=2.0:psy-rdoq=2.0:rd=6']
        },
        av1: {
            videoCodec: 'libsvtav1',
            audioCodec: 'libopus',
            container: 'mp4',
            preset: '3',  // SVT-AV1 更慢的预设以获得更好压缩（0-13，数字越小越慢越好）
            extraArgs: [
                '-movflags', '+faststart',
                '-svtav1-params', 'tune=0:enable-overlays=1:enable-qm=1:qm-min=0:film-grain=10:film-grain-denoise=1'
            ]
        },
        vp9: {
            videoCodec: 'libvpx-vp9',
            audioCodec: 'libopus',
            container: 'webm',
            preset: 'best',  // 最佳质量模式
            extraArgs: [
                '-row-mt', '1',
                '-tile-columns', '2',
                '-cpu-used', '0',  // 最慢但压缩率最高
                '-auto-alt-ref', '6',
                '-lag-in-frames', '25',
                '-arnr-maxframes', '15',
                '-arnr-strength', '6'
            ]
        }
    };

    /**
     * 检查 FFmpeg 是否可用
     */
    static async checkFFmpegAvailable(): Promise<boolean> {
        return new Promise((resolve) => {
            const ffmpeg = spawn('ffmpeg', ['-version']);
            ffmpeg.on('error', () => resolve(false));
            ffmpeg.on('close', (code) => resolve(code === 0));
        });
    }

    /**
     * 检查特定编码器是否可用
     */
    static async checkEncoderAvailable(encoder: string): Promise<boolean> {
        return new Promise((resolve) => {
            const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-encoders']);
            let output = '';
            
            ffmpeg.stdout.on('data', (data) => {
                output += data.toString();
            });
            
            ffmpeg.on('close', () => {
                resolve(output.includes(encoder));
            });
            
            ffmpeg.on('error', () => resolve(false));
        });
    }

    /**
     * 自动选择最佳可用编码器（优先选择压缩率高的）
     * 激进模式：强制优先使用 AV1
     */
    static async selectBestCodec(): Promise<'av1' | 'hevc' | 'vp9' | 'h264'> {
        // 按压缩率从高到低检查，AV1 优先级最高
        const codecPriority: Array<{ codec: 'av1' | 'hevc' | 'vp9' | 'h264', encoder: string }> = [
            { codec: 'av1', encoder: 'libsvtav1' },      // SVT-AV1 速度快
            { codec: 'av1', encoder: 'libaom-av1' },     // libaom-av1 压缩率更高但慢
            { codec: 'av1', encoder: 'librav1e' },       // rav1e 另一个 AV1 实现
            { codec: 'hevc', encoder: 'libx265' },       // HEVC 次选
            { codec: 'vp9', encoder: 'libvpx-vp9' },     // VP9 第三选择
            { codec: 'h264', encoder: 'libx264' }        // H.264 回退
        ];

        for (const { codec, encoder } of codecPriority) {
            if (await this.checkEncoderAvailable(encoder)) {
                console.log(`[VideoProcessing] 🚀 Selected AGGRESSIVE codec: ${codec} (${encoder})`);
                return codec;
            }
        }

        console.warn('[VideoProcessing] ⚠️  No modern codecs available, falling back to h264');
        return 'h264';
    }

    /**
     * 获取视频信息
     */
    static async getVideoInfo(inputPath: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const ffprobe = spawn('ffprobe', [
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_format',
                '-show_streams',
                inputPath
            ]);

            let output = '';
            ffprobe.stdout.on('data', (data) => {
                output += data.toString();
            });

            ffprobe.on('close', (code) => {
                if (code === 0) {
                    try {
                        resolve(JSON.parse(output));
                    } catch (e) {
                        reject(new Error('Failed to parse video info'));
                    }
                } else {
                    reject(new Error('FFprobe failed'));
                }
            });

            ffprobe.on('error', reject);
        });
    }
    /**
     * 压缩转码视频文件 - 使用现代化高压缩率编码器（激进模式）
     */
    static async processVideo(
        inputPath: string,
        outputPath: string,
        options: VideoProcessingOptions = {}
    ): Promise<VideoProcessingResult> {
        const startTime = Date.now();
        
        try {
            // 检查 FFmpeg 可用性
            if (!(await this.checkFFmpegAvailable())) {
                throw new Error('FFmpeg not available');
            }

            // 获取原始文件信息
            const originalStats = await fs.stat(inputPath);
            const videoInfo = await this.getVideoInfo(inputPath);
            
            const videoStream = videoInfo.streams.find((s: any) => s.codec_type === 'video');
            if (!videoStream) {
                throw new Error('No video stream found');
            }

            // 自动选择最佳编码器（如果未指定）
            const codec = options.codec || await this.selectBestCodec();
            const codecConfig = this.CODEC_CONFIG[codec];
            
            // 应用质量预设
            const quality = options.quality || 'medium';
            const preset = this.QUALITY_PRESETS[quality];
            const crf = preset.crf[codec];
            
            // 激进模式：默认启用两遍编码以获得最佳压缩率
            const twoPass = options.twoPass !== false;  // 默认 true
            
            console.log(`[VideoProcessing] 🚀 AGGRESSIVE MODE: ${codec} codec, quality: ${quality}, CRF: ${crf}, Two-Pass: ${twoPass}`);

            // 构建基础 FFmpeg 参数
            const baseArgs = [
                '-i', inputPath
            ];

            // 添加分辨率限制和滤镜
            const maxWidth = options.maxWidth || preset.maxWidth;
            const maxHeight = options.maxHeight || preset.maxHeight;
            
            const filters: string[] = [];
            if (videoStream.width > maxWidth || videoStream.height > maxHeight) {
                filters.push(`scale='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease`);
            }

            // 对于现代编码器，添加激进的降噪和优化滤镜以提高压缩效率
            if (codec === 'av1' || codec === 'hevc') {
                filters.push('hqdn3d=2.0:2.0:8:8');  // 更激进的降噪
                filters.push('unsharp=5:5:0.8:3:3:0.4');  // 锐化以补偿降噪
            } else if (codec === 'vp9') {
                filters.push('hqdn3d=1.8:1.8:7:7');
            }

            const videoArgs = [
                '-c:v', codecConfig.videoCodec,
                '-b:v', options.videoBitrate || preset.videoBitrate,
                '-maxrate', options.videoBitrate || preset.videoBitrate,
                '-bufsize', '2M'
            ];

            // 添加编码器特定的 preset
            if (codec === 'av1') {
                videoArgs.push('-preset', codecConfig.preset);
            } else if (codec === 'vp9') {
                videoArgs.push('-quality', codecConfig.preset);
                videoArgs.push('-speed', '0');  // VP9 最慢速度以获得最佳压缩
            } else {
                videoArgs.push('-preset', codecConfig.preset);
            }

            const audioArgs = [
                '-c:a', codecConfig.audioCodec,
                '-b:a', options.audioBitrate || preset.audioBitrate
            ];

            // 音频压缩优化
            if (codecConfig.audioCodec === 'libopus') {
                audioArgs.push('-compression_level', '10');  // Opus 最高压缩级别
                audioArgs.push('-application', 'audio');  // 优化音频内容
            } else if (codecConfig.audioCodec === 'aac') {
                audioArgs.push('-aac_coder', 'twoloop');  // AAC 最佳编码器
            }

            if (filters.length > 0) {
                videoArgs.push('-vf', filters.join(','));
            }

            // 两遍编码以获得最佳压缩率
            if (twoPass && (codec === 'vp9' || codec === 'hevc' || codec === 'h264')) {
                console.log('[VideoProcessing] 🎯 Using two-pass encoding for optimal compression');
                
                // 第一遍：分析
                const pass1Args = [
                    ...baseArgs,
                    ...videoArgs,
                    '-pass', '1',
                    '-passlogfile', `/tmp/ffmpeg-pass-${Date.now()}`,
                    '-an',  // 第一遍不处理音频
                    '-f', codecConfig.container === 'webm' ? 'webm' : 'mp4',
                    '-y', '/dev/null'
                ];
                
                console.log('[VideoProcessing] Pass 1/2: Analyzing...');
                await this.runFFmpeg(pass1Args);
                
                // 第二遍：编码
                const pass2Args = [
                    ...baseArgs,
                    ...videoArgs,
                    '-pass', '2',
                    '-passlogfile', `/tmp/ffmpeg-pass-${Date.now()}`,
                    ...audioArgs,
                    ...codecConfig.extraArgs,
                    '-y', outputPath
                ];
                
                console.log('[VideoProcessing] Pass 2/2: Encoding...');
                await this.runFFmpeg(pass2Args);
            } else {
                // 单遍编码（AV1 使用 CRF 模式）
                const args = [
                    ...baseArgs,
                    ...videoArgs,
                    '-crf', crf.toString(),
                    ...audioArgs,
                    ...codecConfig.extraArgs,
                    '-y', outputPath
                ];
                
                console.log(`[VideoProcessing] Single-pass encoding with CRF ${crf}`);
                await this.runFFmpeg(args);
            }

            // 获取处理后的文件信息
            const processedStats = await fs.stat(outputPath);
            const processedInfo = await this.getVideoInfo(outputPath);
            const processedVideoStream = processedInfo.streams.find((s: any) => s.codec_type === 'video');

            const compressionRatio = ((originalStats.size - processedStats.size) / originalStats.size) * 100;

            console.log(`[VideoProcessing] ✅ Completed: ${originalStats.size} -> ${processedStats.size} bytes (${compressionRatio.toFixed(2)}% reduction)`);

            return {
                status: true,
                originalPath: inputPath,
                processedPath: outputPath,
                originalSize: originalStats.size,
                processedSize: processedStats.size,
                compressionRatio: Math.round(compressionRatio * 100) / 100,
                duration: parseFloat(processedInfo.format.duration),
                width: processedVideoStream?.width,
                height: processedVideoStream?.height,
                processTime: Date.now() - startTime
            };

        } catch (error) {
            console.error('[VideoProcessing] ❌ Error:', error);
            return {
                status: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                processTime: Date.now() - startTime
            };
        }
    }

    /**
     * 执行 FFmpeg 命令
     */
    private static runFFmpeg(args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', args);
            
            let errorOutput = '';
            ffmpeg.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`FFmpeg failed with code ${code}: ${errorOutput}`));
                }
            });

            ffmpeg.on('error', reject);
        });
    }

    /**
     * 生成处理后的文件名
     */
    static generateProcessedFilename(originalPath: string, options: VideoProcessingOptions = {}): string {
        const ext = path.extname(originalPath);
        const basename = path.basename(originalPath, ext);
        const quality = options.quality || 'medium';
        const codec = options.codec || 'auto';
        const codecConfig = codec !== 'auto' ? this.CODEC_CONFIG[codec as keyof typeof this.CODEC_CONFIG] : null;
        const format = options.format || codecConfig?.container || 'mp4';
        
        const hash = crypto.randomBytes(4).toString('hex');
        return `${basename}_${quality}_${codec}_${hash}.${format}`;
    }

    /**
     * 清理临时文件
     */
    static async cleanupFile(filePath: string): Promise<void> {
        try {
            await fs.unlink(filePath);
        } catch (error) {
            console.warn(`Failed to cleanup file ${filePath}:`, error);
        }
    }
}