export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); }
  catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' && (spec.startsWith('./') || spec.startsWith('../'))) return next(spec + '.ts', ctx);
    throw e;
  }
}
