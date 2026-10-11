//! The one message this app publishes (the drive Twist), as LCM bytes. Everything recorded is decoded and transcoded
//! by rust-recorder, which reads every dimos-lcm type from its definitions.

pub const TWIST_TYPE: &str = "geometry_msgs.Twist";
#[cfg(test)]
pub const IMAGE_TYPE: &str = "sensor_msgs.Image";

/// LCM type fingerprints, from dimos-lcm's generated code.
pub const TWIST_FINGERPRINT: [u8; 8] = [0x2e, 0x7c, 0x07, 0xd7, 0xcd, 0xf7, 0xe0, 0x27];
#[cfg(test)]
pub const IMAGE_FINGERPRINT: [u8; 8] = [0x53, 0x5c, 0xfa, 0xce, 0x1f, 0x4f, 0x57, 0x17];

/// `geometry_msgs.Twist`: the fingerprint, then linear and angular xyz as big-endian float64.
pub fn encode_twist(linear: [f64; 3], angular: [f64; 3]) -> Vec<u8> {
    let mut out = Vec::with_capacity(56);
    out.extend_from_slice(&TWIST_FINGERPRINT);
    for value in linear.iter().chain(angular.iter()) {
        out.extend_from_slice(&value.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn twist_matches_python_reference() {
        let encoded = encode_twist([0.0; 3], [0.0; 3]);
        assert_eq!(encoded.len(), 56);
        assert_eq!(encoded[..8], [0x2e, 0x7c, 0x07, 0xd7, 0xcd, 0xf7, 0xe0, 0x27]);
        assert!(encoded[8..].iter().all(|byte| *byte == 0));
        let encoded = encode_twist([0.25, 0.0, 0.0], [0.0, 0.0, -0.5]);
        assert_eq!(&encoded[8..16], &0.25f64.to_be_bytes());
        assert_eq!(&encoded[48..56], &(-0.5f64).to_be_bytes());
    }

    #[test]
    fn fingerprints_agree_with_rust_recorder() {
        let registry = rust_recorder::lcm::registry();
        assert_eq!(registry.fingerprint(TWIST_TYPE).unwrap().to_be_bytes(), TWIST_FINGERPRINT);
        assert_eq!(registry.fingerprint(IMAGE_TYPE).unwrap().to_be_bytes(), IMAGE_FINGERPRINT);
    }
}
