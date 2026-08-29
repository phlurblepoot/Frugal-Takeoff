// src/components/documents/errors.ts
// Shared sentinel so a mid-send cancel can be told apart from a real send
// failure. Lives in its own module because both DocumentActionsBar (which
// throws it) and EmailComposer (which must not toast "Failed to send" for it)
// need it, and the bar already imports the composer.
export class DocumentGenerationCancelled extends Error {
  constructor() {
    super('document-generation-cancelled');
    this.name = 'DocumentGenerationCancelled';
  }
}
