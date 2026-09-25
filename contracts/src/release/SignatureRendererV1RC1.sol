// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Frozen EVM renderer release candidate, NOT an adopted production renderer.
/// @dev Geometry is copied without modification from the fixed18 experiment.
///      VERSION identifies this port, not the upstream Python/TypeScript renderer.
///      No storage, external calls, oracle, supplied geometry or mutable dependency.
contract SignatureRendererV1RC1 {
    int256 private constant Q = 1e18;
    int256 private constant PI = 3141592653589793238;
    int256 private constant CENTER = 210e18;
    string public constant VERSION = "sg-evm-renderer-1.0.0-rc.1";

    struct V { int256 x; int256 y; }
    struct Point { bytes1 character; bool serial; V anchor; V incoming; V outgoing; }
    struct Seed { int256 angle; int256 incoming; int256 outgoing; int256 y; }
    struct Profile { bool extrovert; bool intuitive; bool feeling; bool perceiving; }
    struct DigitLayout { int256 baseY; int256 scale; int256[] advances; }
    struct Output { bytes data; uint256 cursor; }
    error InvalidInput();

    // Private arithmetic only: validated 1–15 ASCII inputs, bounded seeds,
    // <=31 points, normalized t in [0,Q]. Geometry is far below 1e30 scaled;
    // products remain far below int256. Division still rejects zero divisors.
    function _mul(int256 a, int256 b) private pure returns (int256) { unchecked { return a * b / Q; } }
    function _div(int256 a, int256 b) private pure returns (int256) { unchecked { return a * Q / b; } }
    function _abs(int256 a) private pure returns (int256) { return a < 0 ? -a : a; }
    function _digit(bytes1 c) private pure returns (bool) { return c >= "0" && c <= "9"; }
    function _charScope(bytes1 c) private pure returns (bytes memory) {
        return abi.encodePacked('{"kind":"x-handle-character","value":"', c, '"}');
    }
    function _underscoreScope() private pure returns (bytes memory) {
        return bytes('{"kind":"x-handle-underscore","value":"_"}');
    }
    function _unit(bytes memory scope, string memory parameter) private pure returns (int256) {
        bytes32 h = sha256(abi.encodePacked('{"namespace":"signature-field","parameter":"', parameter,
            '","scheme":"sha256-labeled-u53","scope":', scope, '}'));
        return int256(uint256(h) >> 203) * Q / 9007199254740992;
    }
    function _range(int256 u, int256 a, int256 b) private pure returns (int256) {
        return a + _mul(u, b - a);
    }
    function _sin(int256 x) private pure returns (int256 s) {
        x %= 2 * PI;
        if (x > PI) x -= 2 * PI;
        if (x < -PI) x += 2 * PI;
        int256 xx = _mul(x, x);
        int256 term = x;
        s = x;
        for (int256 n = 1; n <= 20; ++n) {
            term = -_mul(term, xx) / ((2 * n) * (2 * n + 1));
            s += term;
        }
    }
    function _profile(string memory mbti) private pure returns (Profile memory p) {
        bytes memory m = bytes(mbti);
        if (m.length != 4 || (m[0] != "I" && m[0] != "E") || (m[1] != "S" && m[1] != "N")
            || (m[2] != "T" && m[2] != "F") || (m[3] != "J" && m[3] != "P")) revert InvalidInput();
        p = Profile(m[0] == "E", m[1] == "N", m[2] == "F", m[3] == "P");
    }
    function _validate(bytes memory h) private pure {
        if (h.length == 0 || h.length > 15) revert InvalidInput();
        for (uint256 i; i < h.length; ++i) {
            bytes1 c = h[i];
            if (!((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || _digit(c) || c == "_")) {
                revert InvalidInput();
            }
        }
    }
    function _y(int256 u, Profile memory p) private pure returns (int256) {
        if (!p.perceiving) return _range(u, -20 * Q, 20 * Q);
        int256 signed = 2 * u - Q;
        int256 magnitude = _abs(signed);
        int256 a = _mul(_mul(magnitude, magnitude), magnitude);
        int256 inverse = Q - magnitude;
        int256 b = _mul(_mul(inverse, inverse), inverse);
        return (signed < 0 ? int256(-40) : signed > 0 ? int256(40) : int256(0)) * _div(a, a + b);
    }
    function _seeds(bytes memory h, Profile memory p) private pure returns (Seed[] memory raw) {
        raw = new Seed[](h.length);
        int256 balance = p.intuitive ? Q / 2 : Q / 10;
        for (uint256 i; i < h.length; ++i) {
            bytes memory scope = _charScope(h[i]);
            int256 incoming = _range(_unit(scope, "incoming-handle-length"), 10 * Q, p.intuitive ? 120 * Q : 40 * Q);
            int256 outgoing = _range(_unit(scope, "outgoing-handle-length"), 10 * Q, p.intuitive ? 120 * Q : 40 * Q);
            int256 mean = (incoming + outgoing) / 2;
            raw[i] = Seed(_mul(_range(_unit(scope, "handle-angle"), -180 * Q, 180 * Q), PI) / 180,
                _mul(incoming, Q - balance) + _mul(mean, balance),
                _mul(outgoing, Q - balance) + _mul(mean, balance),
                h[i] == "_" ? _range(_unit(_underscoreScope(), "point-y-shift"), 0, 50 * Q) : _y(_unit(scope, "point-y-shift"), p));
        }
    }
    function _underscoreWeight() private pure returns (int256) {
        return _range(_unit(_underscoreScope(), "width-weight"), Q, 2 * Q);
    }
    function _gap(bytes1 left, bytes1 right, Profile memory p) private pure returns (int256) {
        if (left == "_" || right == "_") return _underscoreWeight();
        if (!p.perceiving) return Q;
        bytes memory scope = abi.encodePacked('{"kind":"ordered-x-handle-character-pair","left":',
            _charScope(left), ',"right":', _charScope(right), '}');
        return _range(_unit(scope, "point-gap-weight"), 45 * Q / 100, 155 * Q / 100);
    }
    function _identity(bytes1 c, int256 x, Seed memory seed, int256 angle) private pure returns (Point memory) {
        V memory anchor = V(x, CENTER + seed.y);
        int256 dx = _sin(angle + PI / 2);
        int256 dy = _sin(angle);
        return Point(c, false, anchor,
            V(x - _mul(dx, seed.incoming), anchor.y - _mul(dy, seed.incoming)),
            V(x + _mul(dx, seed.outgoing), anchor.y + _mul(dy, seed.outgoing)));
    }
    function _serial(bytes1 c, int256 x, int256 y, int256 pulse) private pure returns (Point memory) {
        return Point(c, true, V(x, y), V(x - pulse, y), V(x + pulse, y));
    }
    function _shift(Point[] memory points, int256 shift) private pure {
        for (uint256 i; i < points.length; ++i) {
            points[i].anchor.x += shift;
            points[i].incoming.x += shift;
            points[i].outgoing.x += shift;
        }
    }
    function _center(Point[] memory points) private pure {
        int256 lo = type(int256).max;
        int256 hi = type(int256).min;
        for (uint256 i; i < points.length; ++i) {
            Point memory a = points[i];
            int256[3] memory xs = [a.anchor.x, a.incoming.x, a.outgoing.x];
            for (uint256 j; j < 3; ++j) { if (xs[j] < lo) lo = xs[j]; if (xs[j] > hi) hi = xs[j]; }
        }
        _shift(points, CENTER - (lo + hi) / 2);
    }
    function _geometry(bytes memory h, Profile memory p) private pure returns (Point[] memory points) {
        Seed[] memory raw = _seeds(h, p);
        int256[] memory angles = new int256[](h.length);
        int256 smoothing = p.intuitive ? Q / 2 : Q / 10;
        bool hasDigits;
        for (uint256 i; i < h.length; ++i) {
            angles[i] = _mul(raw[i].angle, Q - smoothing)
                + _mul((raw[i == 0 ? 0 : i - 1].angle + raw[i + 1 == h.length ? i : i + 1].angle) / 2, smoothing);
            hasDigits = hasDigits || _digit(h[i]);
        }
        int256 span = h.length <= 3 ? 300 * Q * int256(h.length) / 4 : 300 * Q;
        int256 start = CENTER - span / 2;
        if (hasDigits) return _digits(h, p, raw, angles, span, start);
        points = new Point[](h.length == 1 ? 2 : h.length);
        if (h.length == 1) {
            points[0] = _identity(h[0], start, raw[0], angles[0]);
            points[1] = _identity(h[0], start + span, raw[0], angles[0]);
        } else {
            int256[] memory weights = new int256[](h.length - 1);
            int256 total;
            for (uint256 i; i + 1 < h.length; ++i) { weights[i] = _gap(h[i], h[i + 1], p); total += weights[i]; }
            int256 x = start;
            for (uint256 i; i < h.length; ++i) {
                points[i] = _identity(h[i], x, raw[i], angles[i]);
                if (i + 1 < h.length) x += span * weights[i] / total;
            }
        }
        _center(points);
    }
    function _digitLayout(bytes memory h, Profile memory p, int256 span) private pure returns (DigitLayout memory d) {
        bytes memory digitString;
        int256 total;
        d.advances = new int256[](h.length);
        for (uint256 i; i < h.length; ++i) {
            if (_digit(h[i])) { digitString = abi.encodePacked(digitString, h[i]); total += Q; }
            if (i + 1 < h.length) {
                if (_digit(h[i]) != _digit(h[i + 1])) {
                    bytes1 other = _digit(h[i]) ? h[i + 1] : h[i];
                    d.advances[i] = _mul(other == "_" ? (Q + _underscoreWeight()) / 2 : Q, 6 * Q / 10);
                } else if (!_digit(h[i])) d.advances[i] = _gap(h[i], h[i + 1], p);
                total += d.advances[i];
            }
        }
        d.baseY = CENTER + 30 * Q + _y(_unit(abi.encodePacked('{"kind":"x-handle-digits","value":"', digitString, '"}'), "point-y-shift"), p);
        d.scale = _div(span, total);
        for (uint256 i; i < d.advances.length; ++i) d.advances[i] = _mul(d.advances[i], d.scale);
    }
    function _digits(bytes memory h, Profile memory p, Seed[] memory raw, int256[] memory angles,
        int256 span, int256 start) private pure returns (Point[] memory points)
    {
        DigitLayout memory d = _digitLayout(h, p, span);
        points = new Point[](31);
        uint256 count;
        int256 x = start;
        int256 pulse = _mul(d.scale, p.intuitive ? 3 * Q / 10 : Q / 10);
        for (uint256 i; i < h.length; ++i) {
            if (_digit(h[i])) {
                if (i == 0 || !_digit(h[i - 1])) points[count++] = _serial(h[i], x, d.baseY, pulse);
                int256 height = int256(uint256(uint8(h[i]) - 48)) * Q / 9 * 60;
                points[count++] = _serial(h[i], x + d.scale / 2, d.baseY - height, pulse);
                x += d.scale;
                points[count++] = _serial(h[i], x, d.baseY, pulse);
                if (i + 1 < h.length && !_digit(h[i + 1])) x += d.advances[i];
            } else {
                points[count++] = _identity(h[i], x, raw[i], angles[i]);
                if (i + 1 < h.length) x += d.advances[i];
            }
        }
        assembly ("memory-safe") { mstore(points, count) }
        _center(points);
    }
    function _cubic(int256 a, int256 b, int256 c, int256 d, int256 t) private pure returns (int256) {
        unchecked {
        int256 u = Q - t;
        return _mul(_mul(_mul(u, u), u), a) + _mul(_mul(3 * _mul(u, u), t), b)
            + _mul(_mul(3 * u, _mul(t, t)), c) + _mul(_mul(_mul(t, t), t), d);
        }
    }
    function _derivative(int256 a, int256 b, int256 c, int256 d, int256 t) private pure returns (int256) {
        unchecked {
        int256 u = Q - t;
        return _mul(3 * _mul(u, u), b - a) + _mul(6 * _mul(u, t), c - b) + _mul(3 * _mul(t, t), d - c);
        }
    }
    function _weight(Point memory p) private pure returns (int256) {
        if (p.character == "_") return 0;
        if (p.serial || _digit(p.character)) return 5 * Q;
        return p.character >= "A" && p.character <= "Z" ? 15 * Q : 5 * Q;
    }
    function _offset(Point memory a, Point memory b, int256 t, int256 side) private pure returns (V memory) {
        V memory at = V(_cubic(a.anchor.x, a.outgoing.x, b.incoming.x, b.anchor.x, t),
            _cubic(a.anchor.y, a.outgoing.y, b.incoming.y, b.anchor.y, t));
        int256 dx = _derivative(a.anchor.x, a.outgoing.x, b.incoming.x, b.anchor.x, t);
        int256 dy = _derivative(a.anchor.y, a.outgoing.y, b.incoming.y, b.anchor.y, t);
        int256 len = int256(Math.sqrt(uint256(dx * dx + dy * dy)));
        if (len == 0) len = Q;
        int256 w = (_weight(a) + _mul(_weight(b) - _weight(a), _mul(_mul(t, t), 3 * Q - 2 * t))) / 2;
        return V(at.x + _mul(_div(-dy, len), w) * side, at.y + _mul(_div(dx, len), w) * side);
    }
    function _centerOutline(Point[] memory points) private pure {
        int256 lo = type(int256).max;
        int256 hi = type(int256).min;
        for (uint256 i; i + 1 < points.length; ++i) {
            for (uint256 j; j <= 64; ++j) {
                int256 t = int256(j) * Q / 64;
                (int256 left, int256 right) = _outlineX(points[i], points[i + 1], t);
                if (left < lo) lo = left;
                if (right > hi) hi = right;
            }
        }
        _shift(points, CENTER - (lo + hi) / 2);
    }
    // Centering only needs X bounds. Evaluate once, no duplicate normal/sqrt,
    // no unused Y cubic or per-sample vector allocations. Same sample positions.
    function _outlineX(Point memory a, Point memory b, int256 t) private pure returns (int256, int256) {
        int256 x = _cubic(a.anchor.x, a.outgoing.x, b.incoming.x, b.anchor.x, t);
        int256 w = (_weight(a) + _mul(_weight(b) - _weight(a), _mul(_mul(t, t), 3 * Q - 2 * t))) / 2;
        if (w == 0) return (x, x);
        int256 dx = _derivative(a.anchor.x, a.outgoing.x, b.incoming.x, b.anchor.x, t);
        int256 dy = _derivative(a.anchor.y, a.outgoing.y, b.incoming.y, b.anchor.y, t);
        int256 len = int256(Math.sqrt(uint256(dx * dx + dy * dy)));
        if (len == 0) len = Q;
        int256 offset = _abs(_mul(_div(-dy, len), w));
        return (x - offset, x + offset);
    }
    function _coordinate(int256 x) private pure returns (string memory) {
        bool negative = x < 0;
        uint256 rounded = uint256(_abs(x) + Q / 200) / uint256(Q / 100);
        return string(abi.encodePacked(negative && rounded != 0 ? "-" : "", Strings.toString(rounded / 100), ".",
            rounded % 100 < 10 ? "0" : "", Strings.toString(rounded % 100)));
    }
    function _pair(V memory a) private pure returns (bytes memory) { return abi.encodePacked(_coordinate(a.x), ",", _coordinate(a.y)); }
    function _append(Output memory output, bytes memory fragment) private pure {
        bytes memory target = output.data;
        uint256 offset = output.cursor;
        if (offset + fragment.length > target.length) revert InvalidInput();
        assembly ("memory-safe") { mcopy(add(add(target, 32), offset), add(fragment, 32), mload(fragment)) }
        output.cursor += fragment.length;
    }
    function _sampled(Point[] memory points) private pure returns (bytes memory data) {
        uint256 n = (240 + points.length - 1) / points.length;
        if (n < 8) n = 8; if (n > 32) n = 32;
        Output memory output = Output(new bytes(16384), 0);
        _append(output, bytes("M"));
        bool first = true;
        for (uint256 i; i + 1 < points.length; ++i) {
            for (uint256 j; j < n; ++j) {
                _append(output, abi.encodePacked(first ? "" : "L", _pair(_offset(points[i], points[i + 1], int256(j) * Q / int256(n), 1))));
                first = false;
            }
        }
        uint256 end = points.length - 2;
        _append(output, abi.encodePacked("L", _pair(_offset(points[end], points[end + 1], Q, 1)), "L", _pair(_offset(points[end], points[end + 1], Q, -1))));
        for (uint256 i = points.length - 1; i > 0; --i) {
            for (uint256 j = n; j > 0; --j) _append(output, abi.encodePacked("L", _pair(_offset(points[i - 1], points[i], int256(j - 1) * Q / int256(n), -1))));
        }
        _append(output, bytes("Z"));
        data = output.data;
        uint256 length = output.cursor;
        assembly ("memory-safe") { mstore(data, length) }
    }
    function _through(int256 start, int256 third, int256 twoThirds, int256 end) private pure returns (int256, int256) {
        int256 a = 27 * third - 8 * start - end;
        int256 b = 27 * twoThirds - start - 8 * end;
        return ((2 * a - b) / 18, (2 * b - a) / 18);
    }
    function _curve(Point memory a, Point memory b, int256 side) private pure returns (bytes memory) {
        V memory start = _offset(a, b, 0, side);
        V memory third = _offset(a, b, Q / 3, side);
        V memory twoThirds = _offset(a, b, 2 * Q / 3, side);
        V memory end = _offset(a, b, Q, side);
        V memory c1; V memory c2;
        (c1.x, c2.x) = _through(start.x, third.x, twoThirds.x, end.x);
        (c1.y, c2.y) = _through(start.y, third.y, twoThirds.y, end.y);
        return side == 1 ? abi.encodePacked("C", _pair(c1), " ", _pair(c2), " ", _pair(end))
            : abi.encodePacked("C", _pair(c2), " ", _pair(c1), " ", _pair(start));
    }
    function _bezier(Point[] memory points) private pure returns (bytes memory data) {
        data = abi.encodePacked("M", _pair(_offset(points[0], points[1], 0, 1)));
        for (uint256 i; i + 1 < points.length; ++i) data = abi.encodePacked(data, _curve(points[i], points[i + 1], 1));
        uint256 end = points.length - 2;
        data = abi.encodePacked(data, "L", _pair(_offset(points[end], points[end + 1], Q, -1)));
        for (uint256 i = points.length - 1; i > 0; --i) data = abi.encodePacked(data, _curve(points[i - 1], points[i], -1));
        return abi.encodePacked(data, "Z");
    }
    function render(string memory handle, string memory mbti) external pure returns (string memory) {
        bytes memory h = bytes(handle); _validate(h);
        Profile memory p = _profile(mbti);
        Point[] memory points = _geometry(h, p); _centerOutline(points);
        bytes memory path = p.feeling ? _bezier(points) : _sampled(points);
        string memory ink = p.extrovert ? "#000000" : "#f4e7c7";
        return string(abi.encodePacked('<svg viewBox="0 0 420 420" xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><rect x="0" y="0" width="420" height="420" fill="',
            p.extrovert ? "#f4e7c7" : "#000000", '"/><path d="', path, '" fill="', ink,
            '" stroke="none"/><text x="210" y="399" font-size="10" font-weight="200" dominant-baseline="middle" fill="', ink,
            '" text-anchor="middle" font-family="-apple-system, system-ui, Segoe UI, sans-serif">@', handle, '</text></svg>'));
    }
}
