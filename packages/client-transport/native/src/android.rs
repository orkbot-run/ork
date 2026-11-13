// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use jni::errors::ThrowRuntimeExAndDefault;
use jni::jni_mangle;
use jni::objects::JObject;
use jni::EnvUnowned;

#[jni_mangle("com.orkbot.transport.OrkTransportModule")]
pub fn init_platform_verifier<'caller>(
    mut env: EnvUnowned<'caller>,
    _this: JObject<'caller>,
    context: JObject<'caller>,
) {
    env.with_env(|env| rustls_platform_verifier::android::init_with_env(env, context))
        .resolve::<ThrowRuntimeExAndDefault>();
}
