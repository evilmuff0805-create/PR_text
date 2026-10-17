// Resolve presentation policy without changing stored speech or word timestamps.
// A missing mapping is a legacy single-file log. An uncertain lookup must not
// stretch a potentially separate person's track across recorded silence.
export async function holdShortGapsForLog(database, userId, logId) {
  try {
    const { data, error } = await database
      .from('transcription_operations')
      .select('batch_id')
      .eq('user_id', userId)
      .eq('transcription_log_id', logId)
      .maybeSingle();
    if (!error) return !data?.batch_id;
  } catch {
    // Return the saved speech timeline if metadata is temporarily unavailable.
  }
  console.warn('[transcription.timing_policy] lookup_failed');
  return false;
}
