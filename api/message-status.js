// Une réponse HTTP réussie confirme l'acceptation de la requête, pas la remise du message.
export function analyserStatutMessage(message = {}) {
  const statut = String(message.status || '').trim();
  const normalise = statut.toLowerCase().replace(/[\s_-]/g, '');
  const rejete = ['errored', 'error', 'failed', 'failure', 'rejected', 'undelivered',
    'undeliverable', 'expired', 'cancelled', 'canceled', 'deliveryfailed'].includes(normalise);
  const remis = ['delivered', 'read', 'seen'].includes(normalise);
  const erreur = message.error;
  const raison = message.errorMessage || message.failureReason || message.statusReason
    || (typeof erreur === 'string' ? erreur : erreur && (erreur.message || erreur.description || erreur.code))
    || message.errorCode || message.reason;
  return { statut: statut || null, remis, rejete,
    detail: rejete && raison != null ? String(raison).slice(0, 300) : null };
}
