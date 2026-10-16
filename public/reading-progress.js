// Reading progress coordinator: binds every save to an Article identity and
// serializes writes per Article so persistent progress cannot complete out of order.
((global) => {
  function createReadingProgressCoordinator({ save, onApplied = () => {}, onError = () => {} }) {
    let currentArticleId = null;
    let generation = 0;
    const sequences = new Map();
    const tails = new Map();

    function open(articleId) {
      currentArticleId = String(articleId);
      generation += 1;
      return { articleId: currentArticleId, generation };
    }

    function identity() { return { articleId: currentArticleId, generation }; }
    function close() { currentArticleId = null; generation += 1; return identity(); }
    function isCurrent(item) {
      return Boolean(item) && String(item.articleId) === currentArticleId && item.generation === generation;
    }

    function capture(progress) {
      if (!currentArticleId) return null;
      const saveSequence = (sequences.get(currentArticleId) || 0) + 1;
      sequences.set(currentArticleId, saveSequence);
      return { articleId: currentArticleId, generation, saveSequence, ...progress };
    }

    function persist(item) {
      if (!item?.articleId) return Promise.resolve(null);
      const articleId = String(item.articleId);
      const previous = tails.get(articleId) || Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        try {
          const updated = await save(articleId, {
            progressSentenceIndex: item.progressSentenceIndex,
            progressPercent: item.progressPercent,
          }, item);
          if (isCurrent(item)) onApplied(updated, item);
          return updated;
        } catch (error) {
          if (isCurrent(item)) onError(error, item);
          return null;
        }
      });
      const tail = operation.finally(() => {
        if (tails.get(articleId) === tail) tails.delete(articleId);
      });
      tails.set(articleId, tail);
      return operation;
    }

    return { open, close, identity, isCurrent, capture, persist };
  }

  const api = { createReadingProgressCoordinator };
  global.FlashReadingProgress = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
