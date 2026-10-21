// Every built-in layer type registers itself on import. To support a new message type, copy the closest file and
// call registerLayer from your app.
import "./pointcloud.tsx"
import "./pose.tsx"
import "./path.tsx"
import "./graph.tsx"
import "./pose_array.tsx"
import "./marker.ts"
import "./boxes.tsx"
import "./labeled_points.ts"
import "./occupancy.tsx"
import "./tf_frames.tsx"
import "./camera3d.tsx"
import "./detection2d.ts"
