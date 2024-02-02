// Since iOS 11 (2017) Apple has used BoringSSL internally to handle all TLS. This code
// hooks low-level BoringSSL calls, to override all custom certificate validation options complete.
// This is a good intro: https://nabla-c0d3.github.io/blog/2019/05/18/ssl-kill-switch-for-ios12/

try {
    Module.ensureInitialized("libboringssl.dylib");
} catch (e) {
    try {
	    Module.load("libboringssl.dylib");
    } catch (e) {
        console.log('Could not load BoringSSL to hook TLS');
        if (DEBUG_MODE) console.log(e);
    }
}

// Get the peer certificates from an SSL pointer. Returns a pointer to a STACK_OF(CRYPTO_BUFFER)
// which requires use of the next few methods below to actually access.
// https://commondatastorage.googleapis.com/chromium-boringssl-docs/ssl.h.html#SSL_get0_peer_certificates
const SSL_get0_peer_certificates = new NativeFunction(
    Module.findExportByName('libboringssl.dylib', 'SSL_get0_peer_certificates'),
    'pointer', ['pointer']
);

// Stack methods:
// https://commondatastorage.googleapis.com/chromium-boringssl-docs/stack.h.html
const sk_num = new NativeFunction(
    Module.findExportByName('libboringssl.dylib', 'sk_num'),
    'size_t', ['pointer']
);

const sk_value = new NativeFunction(
    Module.findExportByName('libboringssl.dylib', 'sk_value'),
    'pointer', ['pointer', 'int']
);

// Crypto buffer methods:
// https://commondatastorage.googleapis.com/chromium-boringssl-docs/pool.h.html
const crypto_buffer_len = new NativeFunction(
    Module.findExportByName('libboringssl.dylib', 'CRYPTO_BUFFER_len'),
    'size_t', ['pointer']
);

const crypto_buffer_data = new NativeFunction(
    Module.findExportByName('libboringssl.dylib', 'CRYPTO_BUFFER_data'),
    'pointer', ['pointer']
);

const SSL_VERIFY_NONE = 0x0;
const SSL_VERIFY_PEER = 0x1;

const VerificationCallback = new NativeCallback(function (ssl, out_alert) {
    // Extremely dumb certificate validation: we accept any chain where the *exact* CA cert
    // we were given is present. No flexibility for non-trivial cert chains, and zero
    // validation of expiry/hostname/etc.

    const peerCerts = SSL_get0_peer_certificates(ssl);

    // Loop through every cert in the chain:
    for (let i = 0; i < sk_num(peerCerts); i++) {
        // For each cert, check if it *exactly* matches our configured CA cert:
        const cert = sk_value(peerCerts, i);
        const certDataLength = crypto_buffer_len(cert).toNumber();

        if (certDataLength !== CERT_DER.byteLength) continue;

        const certPointer = crypto_buffer_data(cert);
        const certData = new Uint8Array(certPointer.readByteArray(certDataLength));

        if (certData.every((byte, j) => CERT_DER[j] === byte)) {
            return SSL_VERIFY_NONE;
        }
    }

    // No matched peer - fallback to default OpenSSL cert verification
	return SSL_VERIFY_PEER;
},'int',['pointer','pointer']);

const customVerifyAddrs = [
    Module.findExportByName("libboringssl.dylib", "SSL_set_custom_verify"),
    Module.findExportByName("libboringssl.dylib", "SSL_CTX_set_custom_verify")
].filter(Boolean);

customVerifyAddrs.forEach((set_custom_verify_addr) => {
    const set_custom_verify_fn = new NativeFunction(
        set_custom_verify_addr,
        'void', ['pointer', 'int', 'pointer']
    );

    // When this function is called, ignore the provided callback, and
    // configure our callback instead:
    Interceptor.replace(set_custom_verify_fn, new NativeCallback(function(ssl, mode, _ignoredProvidedCallback) {
        set_custom_verify_fn(ssl, mode, VerificationCallback);
    }, 'void', ['pointer', 'int', 'pointer']));
});

const get_psk_identity_addr = Module.findExportByName("libboringssl.dylib", "SSL_get_psk_identity");
if (get_psk_identity_addr) {
    // Hooking this is apparently required for some verification paths which check the
    // result is not 0x0. Any return value should work fine though.
    Interceptor.replace(get_psk_identity_addr, new NativeCallback(function(ssl) {
        return "PSK_IDENTITY_PLACEHOLDER";
    }, 'pointer', ['pointer']));
} else if (customVerifyAddrs.length) {
    console.log(`Patched ${customVerifyAddrs.length} custom_verify methods, but couldn't find get_psk_identity`);
}
