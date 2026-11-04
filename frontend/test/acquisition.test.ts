import { assertEquals, assertAlmostEquals } from "jsr:@std/assert@1"
import { cloudFields, imageFields, depthPixels, rgbPixels, AcquisitionOrder, acquisitionMs } from "../src/core/acquisition.ts"
import { VideoSources } from "../src/core/video.ts"
import type { Connection, Message, SubscribeOptions } from "../src/core/transport.ts"
import fixtures from "./fixtures/acquisition.json" with { type: "json" }
const bytes = (name: keyof typeof fixtures) => Uint8Array.from(atob(fixtures[name]), c=>c.charCodeAt(0))
Deno.test("Python sensor samples preserve reset identity and zero acquisition time",()=>{
 const image=imageFields(bytes("rgb"))
 assertEquals(image.header.clock_id,"sim-proof")
 assertEquals(image.header.epoch,3)
 assertEquals(acquisitionMs(image.header),0)
 assertEquals([...rgbPixels(image)],[255,0,0,255,0,255,0,255])
 const depth=depthPixels(imageFields(bytes("depth")))
 assertAlmostEquals(depth.data[0],1.5)
 assertAlmostEquals(depth.data[1],2.5)
 const cloud=cloudFields(bytes("cloud"))
 assertEquals([...cloud.positions],[1,2,3,-1,-2,-3])
 assertEquals(cloud.frameId,"world")
 assertEquals(cloud.acquisition.epoch,3)
})
Deno.test("a delayed old epoch or retired clock cannot restore pre-reset data",()=>{
 const order=new AcquisitionOrder()
 const h={clock_id:"first",epoch:0,time_ns:100,frame_id:"world"}
 assertEquals(order.accept(h),true)
 assertEquals(order.accept({...h,epoch:1,time_ns:0}),true)
 assertEquals(order.accept(h),false)
 assertEquals(order.accept({...h,clock_id:"second",time_ns:0}),true)
 assertEquals(order.accept({...h,epoch:2}),false)
})
Deno.test("canonical depth bypasses the old header codec and retains its sensor frame",()=>{
 let options: SubscribeOptions|undefined, receive: ((m:Message)=>void)|undefined, stopped=false
 const connection={ subscribe: (_key:string,o:SubscribeOptions,callback:(m:Message)=>void)=>{
  options=o;receive=callback;return ()=>{stopped=true}
 }} as unknown as Connection
 const sources=new VideoSources(connection)
 const topic={key:"dimos/depth_image/sensor_msgs.Image",name:"/depth_image",type:"sensor_msgs.Image"}
 const source=sources.acquire(topic)
 assertEquals(options?.encoding,undefined)
 receive!({key:topic.key,kind:"put",bytes:bytes("depth"),seq:0,timestamp:99999})
 assertEquals(source.frame.get().frameId,"g1/camera")
 assertEquals([...source.depth.get().image!.data],[1.5,2.5])
 sources.release(topic)
 assertEquals(stopped,true)
})
