# Voice

Speech synthesis, transcription, voice credentials, and speech summaries live here. The module selects configured voices, checks requests, and passes audio work to injected provider interfaces. Thread routes own call state. Shared call services stay in workspace packages.

Use `mountVoiceHttpRoutes` for HTTP handlers, `prepareVoice` for voice setup, and `synthesizeVoice` or `transcribeVoice` for audio. `createSpeechSummarizer` provides the application's speech-summary service.
