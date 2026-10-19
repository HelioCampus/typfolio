import { z } from 'zod';

/**
 * The path of an image the template shows, as `render()` or `attach()` returned it. The media type
 * lands in the JSON Schema as `contentMediaType`, so the editor's sample draws a placeholder image.
 */
export function imagePath(mediaType: `image/${string}`) {
  return z.string().meta({ contentMediaType: mediaType });
}
