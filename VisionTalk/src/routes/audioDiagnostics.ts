import type { Express } from 'express';
import type { AppSession } from '@mentra/sdk';
import { speakWithEvent } from '../services/tts';
import { getServerUrl, ENV } from '../config';
import { VoiceConfig, UserState } from '../types';

// This module mounts diagnostic audio endpoints separate from main index.ts
// to avoid cluttering core pipeline logic.
// Requires the host to provide accessors for sessions, user state, queue wrapper, and event recorder.

export interface AudioDiagDeps {
	app: Express;
	getActiveSessionUserIds(): string[];
	getSession(userId: string): AppSession | undefined;
	ensureUserState(userId: string): UserState;
	withAudioQueue<T>(userId: string, fn: () => Promise<T>): Promise<T>;
	recordEvent(stage: string, detail?: any, error?: string): void;
	clearEvents(): void;
}

export function mountAudioDiagnostics(deps: AudioDiagDeps) {
		const { app, getActiveSessionUserIds, getSession, ensureUserState, withAudioQueue, recordEvent, clearEvents } = deps;

	// Helper to resolve a userId from query or first active
	function resolveUserId(req: any): string | null {
		const q = (req.query.userId as string) || null;
		if (q) return q;
		const all = getActiveSessionUserIds();
		return all[0] || null;
	}

		// Active sessions listing
		app.get('/api/diag/audio/active-sessions', (req: any, res: any) => {
		const users = getActiveSessionUserIds();
		res.json({ count: users.length, users });
	});

	// Queue-based TTS only test
	app.get('/api/diag/audio/tts-only', async (req: any, res: any) => {
		try {
			const uid = resolveUserId(req);
			if (!uid) return res.status(404).json({ error: 'No active sessions' });
			const session = getSession(uid);
			if (!session) return res.status(404).json({ error: `No session for user ${uid}` });
			const state = ensureUserState(uid);
			const text = (req.query.text as string) || 'TTS only diagnostic test';
			const voiceConfig: VoiceConfig = { model_id: 'eleven_flash_v2_5' };
			recordEvent('diag_tts_only_start', { userId: uid, text });
			await withAudioQueue(uid, () => speakWithEvent(session, text, voiceConfig, recordEvent, state, 'diag_tts_only'));
			recordEvent('diag_tts_only_done', { userId: uid });
			res.json({ ok: true, userId: uid });
		} catch (e: any) {
			recordEvent('diag_tts_only_error', {}, String(e));
			res.status(500).json({ ok: false, error: String(e) });
		}
	});

	// Queue-based chime only test
	app.get('/api/diag/audio/chime-only', async (req: any, res: any) => {
		try {
			const uid = resolveUserId(req);
			if (!uid) return res.status(404).json({ error: 'No active sessions' });
			const session = getSession(uid);
			if (!session) return res.status(404).json({ error: `No session for user ${uid}` });
			const volume = Math.min(Math.max(Number(req.query.volume ?? 1.0), 0), 1);
			recordEvent('diag_chime_only_start', { userId: uid, volume });
			await withAudioQueue(uid, () => session.audio.playAudio({ audioUrl: getServerUrl() + '/assets/chime-sound.mp3', volume }));
			recordEvent('diag_chime_only_done', { userId: uid });
			res.json({ ok: true, userId: uid });
		} catch (e: any) {
			recordEvent('diag_chime_only_error', {}, String(e));
			res.status(500).json({ ok: false, error: String(e) });
		}
	});

	// Raw speak (no queue) for isolating serialization effects
	app.get('/api/diag/audio/speak-raw', async (req: any, res: any) => {
		try {
			const uid = resolveUserId(req);
			if (!uid) return res.status(404).json({ error: 'No active sessions' });
			const session = getSession(uid);
			if (!session) return res.status(404).json({ error: `No session for user ${uid}` });
			const text = (req.query.text as string) || 'Raw speak diagnostic';
			recordEvent('diag_speak_raw_start', { userId: uid, text });
			const result = await session.audio.speak(text, { model_id: 'eleven_flash_v2_5' });
			recordEvent('diag_speak_raw_result', { userId: uid, success: result.success, duration: result.duration });
			res.json({ ok: true, success: result.success, duration: result.duration });
		} catch (e: any) {
			recordEvent('diag_speak_raw_error', {}, String(e));
			res.status(500).json({ ok: false, error: String(e) });
		}
	});

	// Direct URL playback (no queue)
	app.get('/api/diag/audio/play-url', async (req: any, res: any) => {
		try {
			const uid = resolveUserId(req);
			if (!uid) return res.status(404).json({ error: 'No active sessions' });
			const session = getSession(uid);
			if (!session) return res.status(404).json({ error: `No session for user ${uid}` });
			const audioUrl = (req.query.url as string) || (getServerUrl() + '/assets/chime-sound.mp3');
			const volume = Math.min(Math.max(Number(req.query.volume ?? 1.0), 0), 1);
			recordEvent('diag_play_url_start', { userId: uid, audioUrl, volume });
			const result = await session.audio.playAudio({ audioUrl, volume });
			recordEvent('diag_play_url_result', { userId: uid, success: result.success, duration: result.duration, audioUrl });
			res.json({ ok: true, success: result.success, duration: result.duration, audioUrl });
		} catch (e: any) {
			recordEvent('diag_play_url_error', {}, String(e));
			res.status(500).json({ ok: false, error: String(e) });
		}
	});

		// Clear events (delegated back to main event buffer)
		app.post('/api/diag/audio/events/clear', (req: any, res: any) => {
			clearEvents();
			recordEvent('diag_events_clear');
			res.json({ ok: true });
		});

		// Combined test: queued TTS then chime
		app.get('/api/diag/audio/test', async (req: any, res: any) => {
			try {
				const uid = resolveUserId(req);
				if (!uid) return res.status(404).json({ error: 'No active sessions' });
				const session = getSession(uid);
				if (!session) return res.status(404).json({ error: `No session for user ${uid}` });
				const state = ensureUserState(uid);
				const volume = Math.min(Math.max(Number(req.query.volume ?? 1.0), 0), 1);
				const voiceConfig: VoiceConfig = { model_id: 'eleven_flash_v2_5' };
				recordEvent('diag_audio_test_start', { userId: uid, volume });
				await withAudioQueue(uid, () => speakWithEvent(session, 'Audio test: one, two, three.', voiceConfig, recordEvent, state, 'diag_tts_test'));
				await withAudioQueue(uid, () => session.audio.playAudio({ audioUrl: getServerUrl() + '/assets/chime-sound.mp3', volume }));
				recordEvent('diag_audio_test_done', { userId: uid });
				res.json({ ok: true, userId: uid });
			} catch (e: any) {
				recordEvent('diag_audio_test_error', {}, String(e));
				res.status(500).json({ ok: false, error: String(e) });
			}
		});
}

// Optional: future expansion for volume diff tests or hash comparisons can go here.
