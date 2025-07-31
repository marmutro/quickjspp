/*****************************************************************************************
 * GMRT-Simple.js
 ****************************************************************************************/

const moduleName = "GMRT-Simple";

log_message("evaluating " + moduleName);

const out_Start =
  context.hardware.get_binary_pin_with_safety_constraints("Output_Start");

//===========================================================================
const get_local_log = (prefix) => {
  return (msg) => {
    log_message(moduleName + " >> " + prefix + " >> " + msg);
  };
};

context.on_clean_up_without_power(async function (work_token) {
  const local_log = get_local_log("on_clean_up_without_power");
  local_log("started");
  try {
    const l= await out_Start.set(work_token, low);
    local_log("awaited set low = " + l);
    const h= await out_Start.set(work_token, high);
    local_log("awaited set high = "+ h);
    await out_Start.set(work_token, illegal);
  } catch (error) {
    local_log("caught error '"+error+"'");
  }
  local_log("finished");
});

var resolve_promise = null;

function doAsync() {
   return new Promise(resolve => {
       resolve_promise = () => {
           resolve('resolved');
       };
   });
}

var fun = async function() {
    result = await doAsync();
    log_message('awaited doAsync result='+result);
    return result;
};

log_message("evaluated " + moduleName);
