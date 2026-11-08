/* Runs the chain walk away from the render thread. The page posts one job and the
   worker answers with progress frames and a single result frame. */
importScripts('verify.js');

self.onmessage = function (event) {
  var job = event.data || {};
  var result;
  try {
    result = self.CTVerify.verifyRound(job, function (done, total) {
      self.postMessage({ type: 'progress', done: done, total: total });
    });
  } catch (err) {
    result = { fatal: String((err && err.message) || err || 'The verifier failed.') };
  }
  self.postMessage({ type: 'result', result: result });
};
