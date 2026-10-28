import { component, defineMarkdocConfig } from '@astrojs/markdoc/config';

// Bloques que el editor (Keystatic) puede insertar dentro de un artículo.
export default defineMarkdocConfig({
  tags: {
    youtube: {
      render: component('./src/components/YouTube.astro'),
      attributes: {
        url: { type: String, required: true },
        title: { type: String }
      },
      selfClosing: true
    }
  }
});
