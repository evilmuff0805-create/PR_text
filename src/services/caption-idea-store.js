import { supabaseAdmin } from '../lib/supabase.js';

export async function getCaptionIdeaStatus(userId, knownCredits = null) {
  const walletPromise = supabaseAdmin
    .from('caption_idea_wallets')
    .select('remaining_uses')
    .eq('user_id', userId)
    .maybeSingle();

  const profilePromise = knownCredits === null
    ? supabaseAdmin.from('profiles').select('credits').eq('id', userId).maybeSingle()
    : Promise.resolve({ data: { credits: knownCredits }, error: null });

  const [{ data: wallet, error: walletError }, { data: profile, error: profileError }] = await Promise.all([
    walletPromise,
    profilePromise,
  ]);

  if (walletError || profileError || !profile) {
    throw new Error(walletError?.message || profileError?.message || '사용 정보를 찾을 수 없습니다.');
  }

  return {
    credits: Number(profile.credits || 0),
    remainingUses: Number(wallet?.remaining_uses || 0),
  };
}

export async function findCompletedCaptionIdeaRequest(requestId, userId) {
  const { data, error } = await supabaseAdmin
    .from('caption_idea_requests')
    .select('id, ideas, credits_charged, remaining_uses_after, model, completed_at, ideas_expires_at')
    .eq('id', requestId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
}

export async function completeCaptionIdeaRequest({ requestId, userId, mode, generation }) {
  const { data, error } = await supabaseAdmin.rpc('complete_caption_idea_request', {
    p_request_id: requestId,
    p_user_id: userId,
    p_mode: mode,
    p_ideas: generation.ideas,
    p_model: generation.model,
    p_prompt_tokens: generation.usage.promptTokens,
    p_cached_tokens: generation.usage.cachedTokens,
    p_completion_tokens: generation.usage.completionTokens,
    p_estimated_cost_usd: generation.estimatedCostUsd,
    p_duration_ms: generation.durationMs,
  });

  if (error) {
    const storeError = new Error(error.message);
    storeError.code = error.code;
    throw storeError;
  }

  const result = data?.[0];
  if (!result) throw new Error('자막 아이디어 사용 정보를 저장하지 못했습니다.');
  return result;
}

export async function cleanupCaptionIdeaRequests() {
  const { data, error } = await supabaseAdmin.rpc('cleanup_caption_idea_requests');
  if (error) throw new Error(error.message);
  return data?.[0] || { ideas_cleared: 0, requests_deleted: 0 };
}

export function startCaptionIdeaMaintenance() {
  if (process.env.CAPTION_IDEAS_ENABLED === 'false') return null;

  const run = async () => {
    try {
      const result = await cleanupCaptionIdeaRequests();
      if (result.ideas_cleared || result.requests_deleted) {
        console.log('[caption_ideas.cleanup]', JSON.stringify(result));
      }
    } catch (error) {
      console.warn('[caption_ideas.cleanup_failed]', JSON.stringify({ message: error.message }));
    }
  };

  const initialTimer = setTimeout(run, 15_000);
  initialTimer.unref?.();
  const interval = setInterval(run, 6 * 60 * 60 * 1000);
  interval.unref?.();
  return interval;
}
