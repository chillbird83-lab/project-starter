// Idea board: video ideas saved from "Why did it work?" (or typed in), worked through in three stages.

export const STAGES = [['todo', 'To make'], ['making', 'Making'], ['done', 'Published']];
const STAGE_IDS = STAGES.map(([s]) => s);
export const stageName = (s) => STAGES.find(([id]) => id === s)?.[1] ?? 'To make';
/** The stage a card's main button moves it to. */
export const nextStage = (s) => ({ todo: 'making', making: 'done', done: 'todo' })[s] ?? 'making';

export const IDEA_LIMITS = { title: 200, angle: 600, notes: 2000, formula: 200 };

const clip = (s, n) => String(s ?? '').trim().slice(0, n);

/** A clean idea: trimmed, bounded, a known stage. */
export function cleanIdea(i = {}) {
  return {
    ...i,
    title: clip(i.title, IDEA_LIMITS.title).replace(/\s+/g, ' '),
    angle: clip(i.angle, IDEA_LIMITS.angle),
    notes: clip(i.notes, IDEA_LIMITS.notes),
    formula: clip(i.formula, IDEA_LIMITS.formula),
    status: STAGE_IDS.includes(i.status) ? i.status : 'todo',
    videoId: i.videoId ?? null,
    sourceYtVideoId: clip(i.sourceYtVideoId, 20),
    sourceTitle: clip(i.sourceTitle, 300),
    sourceChannel: clip(i.sourceChannel, 200),
    sourceScore: Number.isFinite(Number(i.sourceScore)) && i.sourceScore != null ? Number(i.sourceScore) : null,
  };
}

/** An idea from an analysis, remembering the video (and its title formula) it came from. */
export const ideaFromAnalysis = (video, idea, analysis, channelTitle = video.channelTitle) => cleanIdea({
  title: idea.title, angle: idea.angle, formula: analysis?.titleFormula, status: 'todo',
  videoId: video.id, sourceYtVideoId: video.ytVideoId, sourceTitle: video.title, sourceChannel: channelTitle, sourceScore: video.score,
});

const key = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Whether this idea (same title, from the same video) is already on the board. */
export const hasIdea = (ideas, videoId, title) => ideas.some((i) => i.videoId === videoId && key(i.title) === key(title));

/** Ideas of one stage, newest change first. */
export const ideasIn = (ideas, stage) => ideas.filter((i) => i.status === stage)
  .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')));
