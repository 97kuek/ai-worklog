/// FNV-1a 64-bit。保存するハッシュに使う。std の DefaultHasher は
/// Rust の版で値が変わりうるので、保存した値と比べる用途には使わない
#[derive(Clone, Copy, Debug)]
pub struct Fnv1a(u64);

const OFFSET_BASIS: u64 = 0xcbf29ce484222325;
const PRIME: u64 = 0x100000001b3;

impl Default for Fnv1a {
    fn default() -> Self {
        Fnv1a(OFFSET_BASIS)
    }
}

impl Fnv1a {
    pub fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0 ^ u64::from(b)).wrapping_mul(PRIME);
        }
    }

    pub fn finish(self) -> u64 {
        self.0
    }
}

pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h = Fnv1a::default();
    h.write(bytes);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_known_fnv1a64_vectors() {
        assert_eq!(fnv1a64(b""), 0xcbf29ce484222325);
        assert_eq!(fnv1a64(b"a"), 0xaf63dc4c8601ec8c);
        assert_eq!(fnv1a64(b"foobar"), 0x85944171f73967e8);
        // 分けて書いても同じ
        let mut h = Fnv1a::default();
        h.write(b"foo");
        h.write(b"bar");
        assert_eq!(h.finish(), 0x85944171f73967e8);
    }
}
