// Cover lookup + task creation + dispatch in one in-flight promise per idempotency key.
const pending = new Map();
export function singleFlight(key, operation) {
    if (pending.has(key)) return pending.get(key);
    const promise = Promise.resolve().then(operation);
    pending.set(key, promise);
    const clear = () => { if (pending.get(key) === promise) pending.delete(key); };
    promise.then(clear, clear);
    return promise;
}
