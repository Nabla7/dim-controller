//! Just enough Python pickle for dimos's zenoh RPCs (manipulation.rs): a decoder for the replies (protocol 2-5, the
//! opcodes CPython's pickler writes for dataclasses, enums, dimos messages and numpy scalars) into JSON, and an encoder
//! for the requests (plain values and dimos messages built the way Python pickles them: class, NEWOBJ, BUILD state).
//! Nothing is executed: a class is only a name, an object its constructor arguments and state. dimos's RPCs will
//! become JSON; then this goes.
use std::collections::HashMap;

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Map, Value as Json};

/// A decoded pickle value. Objects keep their class name, NEWOBJ / REDUCE arguments and BUILD state.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    None,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Bytes(Vec<u8>),
    List(Vec<Value>),
    Tuple(Vec<Value>),
    Dict(Vec<(Value, Value)>),
    Class(String),
    Object {
        class: String,
        args: Vec<Value>,
        state: Option<Box<Value>>,
    },
}

/// The decoder's working values: containers hold arena indices, so a memoized list that is appended to after
/// MEMOIZE (CPython's order) is the same list wherever it is referenced.
#[derive(Debug, Clone)]
enum Node {
    Leaf(Value),
    List(Vec<usize>),
    Tuple(Vec<usize>),
    Dict(Vec<(usize, usize)>),
    Object {
        class: String,
        args: Vec<usize>,
        state: Option<usize>,
    },
}

enum Slot {
    Mark,
    Node(usize),
}

struct Machine<'a> {
    data: &'a [u8],
    at: usize,
    arena: Vec<Node>,
    stack: Vec<Slot>,
    memo: HashMap<u32, usize>,
}

impl<'a> Machine<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        let end = self.at.checked_add(count).filter(|end| *end <= self.data.len());
        let end = end.ok_or_else(|| anyhow!("pickle ends early at byte {}", self.at))?;
        let bytes = &self.data[self.at..end];
        self.at = end;
        Ok(bytes)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into()?))
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into()?))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into()?))
    }
    fn len_u64(&mut self) -> Result<usize> {
        usize::try_from(self.u64()?).map_err(|_| anyhow!("pickle length too large"))
    }
    fn string(&mut self, count: usize) -> Result<String> {
        Ok(String::from_utf8(self.take(count)?.to_vec())?)
    }
    fn line(&mut self) -> Result<String> {
        let rest = &self.data[self.at..];
        let end = rest.iter().position(|b| *b == b'\n').ok_or_else(|| anyhow!("pickle GLOBAL without a newline"))?;
        let text = String::from_utf8(rest[..end].to_vec())?;
        self.at += end + 1;
        Ok(text)
    }

    fn push(&mut self, node: Node) {
        self.arena.push(node);
        self.stack.push(Slot::Node(self.arena.len() - 1));
    }
    fn leaf(&mut self, value: Value) {
        self.push(Node::Leaf(value));
    }
    fn pop(&mut self) -> Result<usize> {
        match self.stack.pop() {
            Some(Slot::Node(index)) => Ok(index),
            Some(Slot::Mark) => bail!("pickle: a MARK where a value was expected"),
            None => bail!("pickle: stack underflow"),
        }
    }
    fn top(&self) -> Result<usize> {
        match self.stack.last() {
            Some(Slot::Node(index)) => Ok(*index),
            _ => bail!("pickle: no value on the stack"),
        }
    }
    /// The values pushed since the last MARK, oldest first; the MARK is removed.
    fn since_mark(&mut self) -> Result<Vec<usize>> {
        let mark = self.stack.iter().rposition(|slot| matches!(slot, Slot::Mark)).ok_or_else(|| anyhow!("pickle: no MARK"))?;
        let items = self.stack.split_off(mark + 1);
        self.stack.pop();
        Ok(items.into_iter().map(|slot| match slot {
            Slot::Node(index) => index,
            Slot::Mark => unreachable!(),
        }).collect())
    }
    fn class_name(&self, index: usize) -> Result<String> {
        match &self.arena[index] {
            Node::Leaf(Value::Class(name)) => Ok(name.clone()),
            other => bail!("pickle: expected a class, got {other:?}"),
        }
    }
    fn str_of(&self, index: usize) -> Result<String> {
        match &self.arena[index] {
            Node::Leaf(Value::Str(text)) => Ok(text.clone()),
            other => bail!("pickle: expected a string, got {other:?}"),
        }
    }
    fn tuple_items(&self, index: usize) -> Result<Vec<usize>> {
        match &self.arena[index] {
            Node::Tuple(items) => Ok(items.clone()),
            other => bail!("pickle: expected a tuple of arguments, got {other:?}"),
        }
    }
    fn append(&mut self, list: usize, items: Vec<usize>) -> Result<()> {
        match &mut self.arena[list] {
            Node::List(existing) => {
                existing.extend(items);
                Ok(())
            }
            other => bail!("pickle: APPEND to {other:?}"),
        }
    }
    fn set_items(&mut self, dict: usize, items: Vec<usize>) -> Result<()> {
        if items.len() % 2 != 0 {
            bail!("pickle: SETITEMS with an odd count");
        }
        match &mut self.arena[dict] {
            Node::Dict(existing) => {
                existing.extend(items.chunks(2).map(|pair| (pair[0], pair[1])));
                Ok(())
            }
            other => bail!("pickle: SETITEM on {other:?}"),
        }
    }

    fn run(&mut self) -> Result<usize> {
        loop {
            let opcode = self.u8()?;
            match opcode {
                0x80 => {
                    let protocol = self.u8()?;
                    if protocol > 5 {
                        bail!("pickle protocol {protocol}");
                    }
                }
                0x95 => {
                    self.u64()?;
                }
                b'.' => return self.pop(),
                b'(' => self.stack.push(Slot::Mark),
                b'0' => {
                    self.stack.pop();
                }
                b'1' => {
                    self.since_mark()?;
                }
                b'2' => {
                    let top = self.top()?;
                    self.stack.push(Slot::Node(top));
                }
                b'N' => self.leaf(Value::None),
                0x88 => self.leaf(Value::Bool(true)),
                0x89 => self.leaf(Value::Bool(false)),
                b'J' => {
                    let value = i32::from_le_bytes(self.take(4)?.try_into()?);
                    self.leaf(Value::Int(value.into()));
                }
                b'K' => {
                    let value = self.u8()?;
                    self.leaf(Value::Int(value.into()));
                }
                b'M' => {
                    let value = self.u16()?;
                    self.leaf(Value::Int(value.into()));
                }
                0x8a => {
                    let count = self.u8()? as usize;
                    let bytes = self.take(count)?;
                    if count > 8 {
                        bail!("pickle: an integer wider than 64 bits");
                    }
                    let mut value: i64 = 0;
                    for (shift, byte) in bytes.iter().enumerate() {
                        value |= (*byte as i64) << (8 * shift);
                    }
                    if count > 0 && count < 8 && bytes[count - 1] & 0x80 != 0 {
                        value -= 1i64 << (8 * count);
                    }
                    self.leaf(Value::Int(value));
                }
                b'G' => {
                    let value = f64::from_be_bytes(self.take(8)?.try_into()?);
                    self.leaf(Value::Float(value));
                }
                0x8c => {
                    let count = self.u8()? as usize;
                    let text = self.string(count)?;
                    self.leaf(Value::Str(text));
                }
                b'X' => {
                    let count = self.u32()? as usize;
                    let text = self.string(count)?;
                    self.leaf(Value::Str(text));
                }
                0x8d => {
                    let count = self.len_u64()?;
                    let text = self.string(count)?;
                    self.leaf(Value::Str(text));
                }
                b'C' => {
                    let count = self.u8()? as usize;
                    let bytes = self.take(count)?.to_vec();
                    self.leaf(Value::Bytes(bytes));
                }
                b'B' => {
                    let count = self.u32()? as usize;
                    let bytes = self.take(count)?.to_vec();
                    self.leaf(Value::Bytes(bytes));
                }
                0x8e | 0x96 => {
                    let count = self.len_u64()?;
                    let bytes = self.take(count)?.to_vec();
                    self.leaf(Value::Bytes(bytes));
                }
                b')' => self.push(Node::Tuple(vec![])),
                b't' => {
                    let items = self.since_mark()?;
                    self.push(Node::Tuple(items));
                }
                0x85..=0x87 => {
                    let count = (opcode - 0x84) as usize;
                    let mut items = (0..count).map(|_| self.pop()).collect::<Result<Vec<_>>>()?;
                    items.reverse();
                    self.push(Node::Tuple(items));
                }
                b']' => self.push(Node::List(vec![])),
                b'l' => {
                    let items = self.since_mark()?;
                    self.push(Node::List(items));
                }
                b'a' => {
                    let item = self.pop()?;
                    let list = self.top()?;
                    self.append(list, vec![item])?;
                }
                b'e' => {
                    let items = self.since_mark()?;
                    let list = self.top()?;
                    self.append(list, items)?;
                }
                b'}' => self.push(Node::Dict(vec![])),
                b'd' => {
                    let items = self.since_mark()?;
                    self.push(Node::Dict(vec![]));
                    let dict = self.top()?;
                    self.set_items(dict, items)?;
                }
                b's' => {
                    let value = self.pop()?;
                    let key = self.pop()?;
                    let dict = self.top()?;
                    self.set_items(dict, vec![key, value])?;
                }
                b'u' => {
                    let items = self.since_mark()?;
                    let dict = self.top()?;
                    self.set_items(dict, items)?;
                }
                // sets become lists: nothing these RPCs return relies on set semantics
                0x8f => self.push(Node::List(vec![])),
                0x90 => {
                    let items = self.since_mark()?;
                    let set = self.top()?;
                    self.append(set, items)?;
                }
                0x91 => {
                    let items = self.since_mark()?;
                    self.push(Node::List(items));
                }
                0x94 => {
                    let top = self.top()?;
                    let key = self.memo.len() as u32;
                    self.memo.insert(key, top);
                }
                b'q' => {
                    let key = self.u8()? as u32;
                    let top = self.top()?;
                    self.memo.insert(key, top);
                }
                b'r' => {
                    let key = self.u32()?;
                    let top = self.top()?;
                    self.memo.insert(key, top);
                }
                b'h' | b'j' => {
                    let key = if opcode == b'h' { self.u8()? as u32 } else { self.u32()? };
                    let index = *self.memo.get(&key).ok_or_else(|| anyhow!("pickle: memo {key} unset"))?;
                    self.stack.push(Slot::Node(index));
                }
                b'c' => {
                    let module = self.line()?;
                    let name = self.line()?;
                    self.leaf(Value::Class(format!("{module}.{name}")));
                }
                0x93 => {
                    let name = self.pop()?;
                    let module = self.pop()?;
                    let class = format!("{}.{}", self.str_of(module)?, self.str_of(name)?);
                    self.leaf(Value::Class(class));
                }
                b'R' | 0x81 => {
                    let args = self.pop()?;
                    let class = self.pop()?;
                    let node = Node::Object {
                        class: self.class_name(class)?,
                        args: self.tuple_items(args)?,
                        state: None,
                    };
                    self.push(node);
                }
                0x92 => {
                    self.pop()?; // keyword arguments: none of these classes take any
                    let args = self.pop()?;
                    let class = self.pop()?;
                    let node = Node::Object {
                        class: self.class_name(class)?,
                        args: self.tuple_items(args)?,
                        state: None,
                    };
                    self.push(node);
                }
                b'b' => {
                    let state = self.pop()?;
                    let object = self.top()?;
                    match &mut self.arena[object] {
                        Node::Object { state: slot, .. } => *slot = Some(state),
                        other => bail!("pickle: BUILD on {other:?}"),
                    }
                }
                other => bail!("pickle: unsupported opcode 0x{other:02x} at byte {}", self.at - 1),
            }
        }
    }

    fn resolve(&self, index: usize, depth: usize) -> Result<Value> {
        if depth > 200 {
            bail!("pickle: nested too deeply (a cycle?)");
        }
        let all = |items: &[usize]| items.iter().map(|item| self.resolve(*item, depth + 1)).collect::<Result<Vec<_>>>();
        Ok(match &self.arena[index] {
            Node::Leaf(value) => value.clone(),
            Node::List(items) => Value::List(all(items)?),
            Node::Tuple(items) => Value::Tuple(all(items)?),
            Node::Dict(pairs) => Value::Dict(
                pairs.iter().map(|(key, value)| Ok((self.resolve(*key, depth + 1)?, self.resolve(*value, depth + 1)?))).collect::<Result<_>>()?,
            ),
            Node::Object { class, args, state } => Value::Object {
                class: class.clone(),
                args: all(args)?,
                state: state.map(|state| self.resolve(state, depth + 1)).transpose()?.map(Box::new),
            },
        })
    }
}

/// Decode one pickle.
pub fn loads(data: &[u8]) -> Result<Value> {
    let mut machine = Machine { data, at: 0, arena: vec![], stack: vec![], memo: HashMap::new() };
    let top = machine.run()?;
    machine.resolve(top, 0)
}

/// The name of a member of a dimos enum these RPCs return (they pickle as the class and its value only).
fn enum_name(class: &str, value: i64) -> Option<&'static str> {
    let names: &[&str] = match class.rsplit('.').next()? {
        "PlanStatus" => &["SUCCEEDED", "FAILED", "INVALID_TARGET", "AMBIGUOUS_GROUP", "NO_MOTION"],
        "PlanningStatus" => &["SUCCESS", "NO_SOLUTION", "TIMEOUT", "INVALID_START", "INVALID_GOAL", "COLLISION_AT_START", "COLLISION_AT_GOAL", "UNSUPPORTED"],
        "CommandStatus" => &["SUCCEEDED", "REJECTED", "FAILED"],
        "ExecutionStatus" => &["IDLE", "ACCEPTED", "REJECTED", "EXECUTING", "COMPLETED", "ABORTED", "FAULT", "TIMED_OUT", "NO_PLAN", "NO_EXECUTION", "UNCERTAIN"],
        "OperationStatus" => &["IDLE", "PLANNING", "EXECUTING", "COMPLETED", "FAULT"],
        // TrajectoryState counts from 0
        "TrajectoryState" => return ["IDLE", "EXECUTING", "COMPLETED", "ABORTED", "FAULT"].get(usize::try_from(value).ok()?).copied(),
        _ => return None,
    };
    names.get(usize::try_from(value).ok()?.checked_sub(1)?).copied()
}

/// A numpy scalar's value: `numpy._core.multiarray.scalar(dtype, raw bytes)`.
fn numpy_scalar(args: &[Value]) -> Option<Json> {
    let [Value::Object { args: dtype_args, state, .. }, Value::Bytes(raw)] = args else {
        return None;
    };
    let Some(Value::Str(code)) = dtype_args.first() else {
        return None;
    };
    // the dtype's BUILD state is (version, byte order, ...): '>' is the only order to swap for
    let big = matches!(state.as_deref(), Some(Value::Tuple(items)) if matches!(items.get(1), Some(Value::Str(order)) if order == ">"));
    let bytes = |count: usize| -> Option<Vec<u8>> {
        let mut bytes = raw.get(..count)?.to_vec();
        if big {
            bytes.reverse();
        }
        Some(bytes)
    };
    Some(match code.as_str() {
        "f8" => json!(f64::from_le_bytes(bytes(8)?.try_into().ok()?)),
        "f4" => json!(f32::from_le_bytes(bytes(4)?.try_into().ok()?) as f64),
        "i8" => json!(i64::from_le_bytes(bytes(8)?.try_into().ok()?)),
        "i4" => json!(i32::from_le_bytes(bytes(4)?.try_into().ok()?)),
        "u8" => json!(u64::from_le_bytes(bytes(8)?.try_into().ok()?)),
        "u4" => json!(u32::from_le_bytes(bytes(4)?.try_into().ok()?)),
        "b1" => json!(*raw.first()? != 0),
        _ => return None,
    })
}

/// A key as JSON object key: strings as they are, anything else by its JSON text.
fn key_text(key: &Value) -> String {
    match key {
        Value::Str(text) => text.clone(),
        other => to_json(other).to_string(),
    }
}

/// The value as JSON: an object is its state's fields (a `(dict, slots)` state merged) plus `"__class__"` (the
/// class's short name); an enum `{"__class__", "name", "value"}`; a numpy scalar its number; NaN and infinities null.
pub fn to_json(value: &Value) -> Json {
    match value {
        Value::None => Json::Null,
        Value::Bool(flag) => json!(flag),
        Value::Int(number) => json!(number),
        Value::Float(number) => serde_json::Number::from_f64(*number).map(Json::Number).unwrap_or(Json::Null),
        Value::Str(text) => json!(text),
        Value::Bytes(bytes) => json!({ "__bytes__": bytes.len() }),
        Value::List(items) | Value::Tuple(items) => Json::Array(items.iter().map(to_json).collect()),
        Value::Dict(pairs) => Json::Object(pairs.iter().map(|(key, value)| (key_text(key), to_json(value))).collect()),
        Value::Class(name) => json!({ "__class__": name }),
        Value::Object { class, args, state } => {
            let short = class.rsplit('.').next().unwrap_or(class);
            if class.ends_with("multiarray.scalar") {
                if let Some(number) = numpy_scalar(args) {
                    return number;
                }
            }
            if state.is_none() {
                if let [Value::Int(number)] = args.as_slice() {
                    return json!({ "__class__": short, "name": enum_name(class, *number), "value": number });
                }
            }
            let mut fields = Map::new();
            fields.insert("__class__".into(), json!(short));
            let mut merge = |state: &Value| {
                if let Value::Dict(pairs) = state {
                    for (key, value) in pairs {
                        fields.insert(key_text(key), to_json(value));
                    }
                }
            };
            match state.as_deref() {
                Some(Value::Tuple(parts)) => parts.iter().for_each(&mut merge),
                Some(other) => merge(other),
                None if !args.is_empty() => {
                    fields.insert("args".into(), Json::Array(args.iter().map(to_json).collect()));
                }
                None => {}
            }
            Json::Object(fields)
        }
    }
}

/// A value to pickle for a request.
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    None,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    List(Vec<Out>),
    Tuple(Vec<Out>),
    Dict(Vec<(String, Out)>),
    /// `module.Class` built as CPython pickles a plain class: `cls.__new__(cls)`, then `BUILD state`
    Object { class: String, state: Box<Out> },
}

fn write_str(out: &mut Vec<u8>, text: &str) {
    if text.len() < 256 {
        out.push(0x8c);
        out.push(text.len() as u8);
    } else {
        out.push(b'X');
        out.extend((text.len() as u32).to_le_bytes());
    }
    out.extend(text.as_bytes());
}

fn write(out: &mut Vec<u8>, value: &Out) {
    match value {
        Out::None => out.push(b'N'),
        Out::Bool(true) => out.push(0x88),
        Out::Bool(false) => out.push(0x89),
        Out::Int(number) => {
            if let Ok(small) = i32::try_from(*number) {
                out.push(b'J');
                out.extend(small.to_le_bytes());
            } else {
                out.push(0x8a);
                out.push(8);
                out.extend(number.to_le_bytes());
            }
        }
        Out::Float(number) => {
            out.push(b'G');
            out.extend(number.to_be_bytes());
        }
        Out::Str(text) => write_str(out, text),
        Out::List(items) => {
            out.push(b']');
            if !items.is_empty() {
                out.push(b'(');
                items.iter().for_each(|item| write(out, item));
                out.push(b'e');
            }
        }
        Out::Tuple(items) => {
            out.push(b'(');
            items.iter().for_each(|item| write(out, item));
            out.push(b't');
        }
        Out::Dict(pairs) => {
            out.push(b'}');
            if !pairs.is_empty() {
                out.push(b'(');
                for (key, value) in pairs {
                    write_str(out, key);
                    write(out, value);
                }
                out.push(b'u');
            }
        }
        Out::Object { class, state } => {
            let (module, name) = class.rsplit_once('.').unwrap_or(("builtins", class));
            write_str(out, module);
            write_str(out, name);
            out.push(0x93);
            out.push(b')');
            out.push(0x81);
            write(out, state);
            out.push(b'b');
        }
    }
}

/// Pickle (protocol 4, no memo) a value.
pub fn dumps(value: &Out) -> Vec<u8> {
    let mut out = vec![0x80, 4];
    write(&mut out, value);
    out.push(b'.');
    out
}

/// The payload of a dimos RPC call: `(args, kwargs)`.
pub fn rpc_request(args: Vec<Out>, kwargs: Vec<(&str, Out)>) -> Vec<u8> {
    dumps(&Out::Tuple(vec![
        Out::List(args),
        Out::Dict(kwargs.into_iter().map(|(key, value)| (key.to_string(), value)).collect()),
    ]))
}

fn floats(values: &[f64]) -> Out {
    Out::List(values.iter().map(|value| Out::Float(*value)).collect())
}

/// `dimos.msgs.sensor_msgs.JointState` (its state is a plain dict).
pub fn joint_state(names: &[String], positions: &[f64], ts: f64) -> Out {
    Out::Object {
        class: "dimos.msgs.sensor_msgs.JointState.JointState".into(),
        state: Box::new(Out::Dict(vec![
            ("ts".into(), Out::Float(ts)),
            ("frame_id".into(), Out::Str(String::new())),
            ("name".into(), Out::List(names.iter().map(|name| Out::Str(name.clone())).collect())),
            ("position".into(), floats(positions)),
            ("velocity".into(), Out::List(vec![])),
            ("effort".into(), Out::List(vec![])),
        ])),
    }
}

/// A slotted dimos geometry message: state `(dict, slots)`, the same fields in both, as Python writes it.
fn slotted(class: &str, fields: Vec<(String, Out)>) -> Out {
    Out::Object {
        class: class.into(),
        state: Box::new(Out::Tuple(vec![Out::Dict(fields.clone()), Out::Dict(fields)])),
    }
}

/// `dimos.msgs.geometry_msgs.PoseStamped` at position [x, y, z], orientation [x, y, z, w] in frame.
pub fn pose_stamped(frame: &str, position: [f64; 3], orientation: [f64; 4], ts: f64) -> Out {
    let axes = |values: &[f64], names: &[&str]| -> Vec<(String, Out)> {
        names.iter().zip(values).map(|(name, value)| (name.to_string(), Out::Float(*value))).collect()
    };
    Out::Object {
        class: "dimos.msgs.geometry_msgs.PoseStamped.PoseStamped".into(),
        state: Box::new(Out::Tuple(vec![
            Out::Dict(vec![("frame_id".into(), Out::Str(frame.into())), ("ts".into(), Out::Float(ts))]),
            Out::Dict(vec![
                ("position".into(), slotted("dimos.msgs.geometry_msgs.Vector3.Vector3", axes(&position, &["x", "y", "z"]))),
                ("orientation".into(), slotted("dimos.msgs.geometry_msgs.Quaternion.Quaternion", axes(&orientation, &["x", "y", "z", "w"]))),
            ]),
        ])),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!("{}/src/pickle_fixtures/{name}.pkl", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }

    #[test]
    fn decodes_get_state() {
        let state = to_json(&loads(&fixture("get_state")).unwrap());
        assert_eq!(state["__class__"], "ManipulationSnapshot");
        assert_eq!(state["operation_status"]["name"], "COMPLETED");
        assert_eq!(state["execution_status"]["name"], "COMPLETED");
        let group = &state["groups"]["manipulator"];
        assert_eq!(group["joints"]["name"][6], "joint7");
        assert!((group["joints"]["position"][0].as_f64().unwrap() + 1.0).abs() < 1e-6);
        assert_eq!(group["end_effector_pose"]["frame_id"], "world");
        assert!((group["end_effector_pose"]["position"]["x"].as_f64().unwrap() - 0.32592797).abs() < 1e-6);
        assert!((group["end_effector_pose"]["orientation"]["w"].as_f64().unwrap() - 0.223821).abs() < 1e-5);
        assert_eq!(group["joint_presets"]["home"]["position"][3], 0.909);
        assert!(group["joint_presets"]["init"]["position"].is_array());
    }

    #[test]
    fn decodes_a_plan_with_its_numpy_trajectory() {
        let result = to_json(&loads(&fixture("plan_to_joints")).unwrap());
        assert_eq!(result["status"]["name"], "SUCCEEDED");
        let plan = &result["plan"];
        assert_eq!(plan["plan_id"], "84a9de8e36c04ece99efcd5d7716bf88");
        assert_eq!(plan["status"]["name"], "SUCCESS");
        let trajectory = &plan["trajectory"];
        assert_eq!(trajectory["joint_names"].as_array().unwrap().len(), 7);
        let points = trajectory["points"].as_array().unwrap();
        assert_eq!(points.len(), 254);
        let last = points.last().unwrap();
        // numpy scalars come out as numbers
        let end: Vec<f64> = last["positions"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        assert_eq!(end.len(), 7);
        assert!((end[0] - 0.6).abs() < 1e-3 && (end[3] - 1.2).abs() < 1e-3, "{end:?}");
        assert!((last["time_from_start"].as_f64().unwrap() - 2.5298).abs() < 1e-3);
    }

    #[test]
    fn decodes_the_small_replies() {
        let groups = to_json(&loads(&fixture("list_planning_groups")).unwrap());
        assert_eq!(groups[0]["tip_frame"], "link_tcp");
        assert_eq!(groups[0]["joint_names"][0], "joint1");
        assert_eq!(groups[0]["has_gripper"], true);
        assert_eq!(to_json(&loads(&fixture("get_obstacles")).unwrap()), json!({}));
        let cleared = to_json(&loads(&fixture("clear_planned_path")).unwrap());
        assert_eq!(cleared["status"]["name"], "SUCCEEDED");
        let executed = to_json(&loads(&fixture("execute")).unwrap());
        assert_eq!(executed["status"]["name"], "NO_PLAN");
        let cancelled = to_json(&loads(&fixture("cancel")).unwrap());
        assert_eq!(cancelled["trajectory_status"]["state"]["name"], "COMPLETED");
        let failed = to_json(&loads(&fixture("plan_to_poses")).unwrap());
        assert_eq!(failed["status"]["name"], "FAILED");
    }

    /// The requests Python itself sent decode to the same tree the encoder builds.
    #[test]
    fn encoder_matches_what_python_sends() {
        for name in ["get_state", "cancel", "clear_planned_path", "list_planning_groups", "get_obstacles"] {
            assert_eq!(loads(&fixture(&format!("{name}.req"))).unwrap(), loads(&rpc_request(vec![], vec![])).unwrap());
        }
        let execute = rpc_request(vec![], vec![("blocking", Out::Bool(false))]);
        assert_eq!(loads(&execute).unwrap(), loads(&fixture("execute.req")).unwrap());
        let preview = rpc_request(vec![], vec![("duration", Out::Float(1.0))]);
        assert_eq!(loads(&preview).unwrap(), loads(&fixture("preview_plan.req")).unwrap());

        let python = loads(&fixture("plan_to_joints.req")).unwrap();
        let Value::Tuple(parts) = &python else { panic!() };
        let Value::List(args) = &parts[0] else { panic!() };
        let Value::Dict(targets) = &args[0] else { panic!() };
        let Value::Object { state: Some(state), .. } = &targets[0].1 else { panic!() };
        let Value::Dict(fields) = state.as_ref() else { panic!() };
        let ts = fields.iter().find_map(|(k, v)| match (k, v) { (Value::Str(k), Value::Float(ts)) if k == "ts" => Some(*ts), _ => None }).unwrap();
        let names: Vec<String> = (1..=7).map(|i| format!("joint{i}")).collect();
        let ours = rpc_request(
            vec![Out::Dict(vec![("manipulator".into(), joint_state(&names, &[0.6, 0.1, 0.0, 1.2, 0.0, 1.0, 0.0], ts))])],
            vec![("speed_scale", Out::Float(0.5))],
        );
        assert_eq!(loads(&ours).unwrap(), python);

        let python = loads(&fixture("plan_to_poses.req")).unwrap();
        let ours = rpc_request(
            vec![Out::Dict(vec![(
                "manipulator".into(),
                pose_stamped(
                    "world",
                    [0.3259279726923384, -0.5078656865912456, 0.6741535659937608],
                    [0.7761191354731494, -0.4240705030411204, 0.40952104290226726, 0.22382093606966685],
                    1791963651.72545,
                ),
            )])],
            vec![],
        );
        assert_eq!(loads(&ours).unwrap(), python);
    }

    /// The encoder's bytes for each request shape, checked in as `ours_<name>.req.pkl` so a Python with dimos can
    /// `pickle.loads` them (scripts/check_pickle_requests.py). UPDATE_PICKLE_FIXTURES=1 rewrites them.
    #[test]
    fn encoder_fixtures_are_current() {
        let names: Vec<String> = (1..=7).map(|i| format!("joint{i}")).collect();
        let requests = [
            ("empty", rpc_request(vec![], vec![])),
            ("execute", rpc_request(vec![], vec![("blocking", Out::Bool(false)), ("plan_id", Out::Str("84a9de8e36c04ece99efcd5d7716bf88".into()))])),
            ("plan_to_joints", rpc_request(vec![Out::Dict(vec![("manipulator".into(), joint_state(&names, &[0.6, 0.1, 0.0, 1.2, 0.0, 1.0, 0.0], 1791963651.7957))])], vec![("speed_scale", Out::Float(0.5))])),
            ("plan_to_poses", rpc_request(vec![Out::Dict(vec![("manipulator".into(), pose_stamped("world", [0.35, 0.2, 0.45], [1.0, 0.0, 0.0, 0.0], 1791963651.7957))])], vec![])),
        ];
        for (name, bytes) in requests {
            let path = format!("{}/src/pickle_fixtures/ours_{name}.req.pkl", env!("CARGO_MANIFEST_DIR"));
            if std::env::var("UPDATE_PICKLE_FIXTURES").is_ok() {
                std::fs::write(&path, &bytes).unwrap();
            }
            assert_eq!(std::fs::read(&path).unwrap(), bytes, "{name}: run with UPDATE_PICKLE_FIXTURES=1 and re-check with scripts/check_pickle_requests.py");
        }
    }

    #[test]
    fn rejects_truncated_and_unknown() {
        let mut bytes = fixture("get_state");
        bytes.truncate(bytes.len() / 2);
        assert!(loads(&bytes).is_err());
        assert!(loads(&[0x80, 4, 0xff]).is_err());
    }
}
