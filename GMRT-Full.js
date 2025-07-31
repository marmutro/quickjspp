
/*****************************************************************************************
* GMRT-Full
*
*
****************************************************************************************/

const moduleName = "GMRT-Full";

//IO Declaration
const out_Start = context.hardware.get_binary_pin_with_safety_constraints("Output_Start");
const out_Reset = context.hardware.get_binary_pin_with_safety_constraints("Output_Reset");
const out_PositioningSystemAway = context.hardware.get_binary_pin("Output_PositioningSystemAway");
const out_ProgrammingMode0 = context.hardware.get_binary_pin("Output_ProgrammingMode0");
const out_ProgrammingMode1 = context.hardware.get_binary_pin("Output_ProgrammingMode1");
const in_Ready = context.hardware.get_binary_pin("Input_Ready");
const in_ProcessDone = context.hardware.get_binary_pin("Input_CycleEnd");

// timout in ms
const ioTimeout = 5000;

// process time 
var moduleTime = "n/a";
var processTime = "n/a";

//-
let crimpLoaded = false;

/*******************************************************************************
 * On Get Information
 ******************************************************************************/
context.on_get_information(function () {
    return {
        "Timing": {
            "Process Time": processTime,
            "Module Time": moduleTime,
        },
    };
})

/*******************************************************************************
 * On Clean Up Without Power
 ******************************************************************************/
context.on_clean_up_without_power(async function (work_token) {
    const local_log = get_local_log("on_clean_up_without_power");
    local_log("started");

    await out_Start.set(work_token, low);
    await out_Reset.set(work_token, low);
    out_PositioningSystemAway.set(work_token, low);

    crimpLoaded = false;

    local_log("finished");
})

/*******************************************************************************
 * On Clean Up
 ******************************************************************************/
context.on_clean_up(async function (work_token) {
    const local_log = get_local_log("on_clean_up");
    local_log("started");

    //if only a GMRT-Full is configurated on the machine this sleep is needed, because the immediate reset after the production leads to a reload error
    if (await in_Ready.wait_for_with_timeout_ms(work_token, high, 300)) {
        local_log("module is not ready, wait loading timeout");
        await context.opt.sleep_ms(work_token, 800);
    }

    await out_Start.set(work_token, low);

    if (!crimpLoaded || in_Ready.get() == low) {
        out_PositioningSystemAway.set(work_token, high);

        if (in_Ready.get() == high) {
            await out_Reset.set(work_token, high);
            await wait_for_input_with_answer(work_token, in_Ready, low, ioTimeout, "on_clean_up");
            await out_Reset.set(work_token, low);
        } else {
            await out_Reset.set(work_token, high);
            await context.opt.sleep_ms(work_token, 300);
            await out_Reset.set(work_token, low);
        }
    }

    //Avoid that GMRT-Full reloads terminal
    out_PositioningSystemAway.set(work_token, low);

    local_log("finished");
})

/*******************************************************************************
 * On Define Obstacle
 ******************************************************************************/
context.on_define_obstacles(function (add_obstacle) {
    const local_log = get_local_log("on_define_obstacles");
    local_log("started");

    //  COORDINATE SYSTEM
    //       ^ +Y
    //       |
    // +X    |
    //  <----+--

    //  LEGEND
    //  i = module position -> origin (0/0)
    //  I = wire
    //  A,D = obstacle corners
    //  wlr, wll = wireline obstacle (housing of GMRT-Full)
    //  insertion = guidetube obstacle (processing area)

    //  |     |           |     |
    //  | wll | insertion | wlr |
    //  |     |   width   |     |<-- Housing of GMRT-Full module simplified
    //  |     |           |     |
    //  |     |___________|     |<-- Module Position
    //  |_____|_____i_____|_____|
    //  A     B     I     C     D
    //              I
    //              I

    const insertionWidth = 20; //mm B-C
    const moduleWidth = 255; //mm A-D
    const yDistanceObstacle = 5; //mm

    //                      ( x,  y )
    const A = get_new_vector(moduleWidth / 2, -yDistanceObstacle);
    const B = get_new_vector(insertionWidth / 2, -yDistanceObstacle);
    const C = get_new_vector(-insertionWidth / 2, -yDistanceObstacle);
    const D = get_new_vector(-moduleWidth / 2, -yDistanceObstacle);

    add_obstacle("obstacle1", A.x, A.y, B.x, B.y, "wireline");
    add_obstacle("insertion", B.x, B.y, C.x, C.y, "guidetube");
    add_obstacle("obstacle2", C.x, C.y, D.x, D.y, "wireline");

    local_log("obstacle1 ( " + A.x + " / " + A.y + " ), ( " + B.x + " / " + B.y + " ) wireline");
    local_log("insertion ( " + B.x + " / " + B.y + " ), ( " + C.x + " / " + C.y + " ) guidetube");
    local_log("obstacle2 ( " + C.x + " / " + C.y + " ), ( " + D.x + " / " + D.y + " ) wireline");
    local_log("finished");
})

/*******************************************************************************
 * On Wire Modifier
 ******************************************************************************/
context.on_wire_modifier(function (parameters, wire_modifier) {
    const local_log = get_local_log("on_wire_modifier");
    local_log("started");

    wire_modifier.set_wire_tip_overlength(parseFloat(parameters.get_context_value("TerminalOverLength")));
    wire_modifier.set_wire_tip_underlength(parseFloat(parameters.get_context_value("TerminalUnderLength")));
    wire_modifier.set_expected_distance_of_process_position_from_station_position(20);
    wire_modifier.set_max_additional_distance_to_process_position(0);

    local_log("finished");
})

/*******************************************************************************
 * On Process Positioning Assemble
 ******************************************************************************/
context.on_process_positioning_assemble(async function (work_token, at_positioning, parameters) {
    const local_log = get_local_log("on_process_positioning_assemble");
    local_log("started");

    out_PositioningSystemAway.set(work_token, low);
    await loadProgram(work_token, parameters);
    await onPositioningProcess(work_token, parameters);
    await wait_for_input_with_answer(work_token, in_ProcessDone, high, ioTimeout, "on_process_positioning_assemble");
    await at_positioning.move_back_as_far_as_possible();
    out_PositioningSystemAway.set(work_token, high);
    await context.opt.sleep_ms(work_token, 500);

    local_log("finished");
})

/*******************************************************************************
 * On Cycle
 ******************************************************************************/
context.on_cycle(async function (work_token, synchronization, parameters) {
    const local_log = get_local_log("on_cycle");
    local_log("started");

    await loadProgram(work_token, parameters);
    const waitReady = waitModuleReady(work_token);

    // Wait for Positioning System
    local_log("wait for positioning_system");
    const positioning_system = await synchronization.get_positioning_system();
    if (!positioning_system) {
        local_log("+++ positioning_system not received +++");
        return;
    }

    const startModuleTime = new Date();
    local_log("wait module ready");
    await waitReady;
    out_PositioningSystemAway.set(work_token, low);

    var after_move;
    if (parameters.get_process_value("Enable_Pre_Centering_Position") === "1") {
        local_log("pre centering position enabled");
        after_move = await positioning_system.move_to_process_position_with_offset(0, parseFloat(parameters.get_process_value("Y_Pre_Centering_Position")), 100);
    } else {
        // move to process position
        after_move = await positioning_system.move_to_process_position(parseInt(parameters.get_process_value("Insertion_Speed")));
    }

    local_log("wait for previous process done");
    const quality = await after_move.wait_previous_process_done();
    if (quality.is_bad() === true) {
        local_log("+++ received quality from previous module was bad +++");
        return;
    }

    // Process
    let process_done = await onCycleProcess(work_token, parameters, positioning_system);

    if (!process_done) {
        crimpLoaded = false;
    }
    await synchronization.set_material_consumption(1);

    local_log("move to EXIT position");
    await positioning_system.move_to_process_position_with_offset(0, parseFloat(parameters.get_process_value("Y_Exit_Offset")), 100);

    local_log("set positioning system free");
    await synchronization.set_positioning_system_free();

    //calculate module time
    moduleTime = (new Date() - startModuleTime) + " ms";
    local_log("Module time " + moduleTime);

    out_PositioningSystemAway.set(work_token, high);

    await synchronization.set_current_process_done(true, {});
    local_log("finished");
})

/*******************************************************************************
 * Local Functions
 ******************************************************************************/
async function onPositioningProcess(work_token, parameters) {
    const local_log = get_local_log("onPositioningProcess");
    local_log("started");

    const startTime = new Date();

    await wait_for_input_with_answer(work_token, in_Ready, high, ioTimeout, "onPositioningProcess");
    await wait_for_input_with_answer(work_token, in_ProcessDone, low, ioTimeout, "onPositioningProcess");

    await out_Start.set(work_token, high);
    await wait_for_input_with_answer(work_token, in_Ready, low, ioTimeout, "onPositioningProcess");

    await out_Start.set(work_token, low);

    //calculate process time
    processTime = (new Date() - startTime) + " ms";

    local_log("Process time " + processTime);
    local_log("finished");
}

//===========================================================================
async function onCycleProcess(work_token, parameters, positioning_system) {
    const local_log = get_local_log("onCycleProcess");
    local_log("started");

    const startTime = new Date();

    await wait_for_input_with_answer(work_token, in_Ready, high, ioTimeout, "onCycleProcess");
    await wait_for_input_with_answer(work_token, in_ProcessDone, low, ioTimeout, "onCycleProcess");

    await out_Start.set(work_token, high);
    if (parameters.get_process_value("Enable_Pre_Centering_Position") === "1") {
        await context.opt.sleep_ms(work_token, parseInt(parameters.get_process_value("Waiting_Time_After_Pre_Centering")));
        // move to process position
        await positioning_system.move_to_process_position(parseInt(parameters.get_process_value("Insertion_Speed")));
    }

    await wait_for_input_with_answer(work_token, in_Ready, low, ioTimeout, "onCycleProcess");

    await out_Start.set(work_token, low);

    const process_done = await wait_for_input_with_answer(work_token, in_ProcessDone, high, ioTimeout, "on_cycle");

    //calculate process time
    processTime = (new Date() - startTime) + " ms";

    local_log("Process time " + processTime);
    local_log("finished");

    return process_done;
}

//===========================================================================
async function waitModuleReady(work_token) {
    const local_log = get_local_log("waitModuleReady");
    local_log("started");

    let retry = true;
    do {
        local_log("in do while");

        let moduleNotReady = false;
        moduleNotReady = await in_Ready.wait_for_with_timeout_ms(work_token, high, ioTimeout);
        if (moduleNotReady) {
            if (retry) {
                local_log("reset GMRT-Full");

                out_PositioningSystemAway.set(work_token, high);

                if (in_Ready.get() == high) {
                    await out_Reset.set(work_token, high);
                    await wait_for_input_with_answer(work_token, in_Ready, low, ioTimeout, "waitModuleReady");
                    await out_Reset.set(work_token, low);
                } else {
                    await out_Reset.set(work_token, high);
                    await context.opt.sleep_ms(work_token, 300);
                    await out_Reset.set(work_token, low);
                }
            }
            retry = !await wait_for_input_with_answer(work_token, in_Ready, high, 100, "waitModuleReady");
        } else {
            retry = false;
            crimpLoaded = true;
            local_log("crimpLoaded");
        }

    } while (retry);

    local_log("finished");
}

//===========================================================================
async function loadProgram(work_token, parameters) {
    const local_log = get_local_log("loadProgram");

    if (parseInt(parameters.get_process_value("Program_Nr")) == 1) {
        local_log("Mode 1");
        out_ProgrammingMode0.set(work_token, low);
        out_ProgrammingMode1.set(work_token, low);
    } else if (parseInt(parameters.get_process_value("Program_Nr")) == 2) {
        local_log("Mode 2");
        out_ProgrammingMode0.set(work_token, high);
        out_ProgrammingMode1.set(work_token, low);
    } else if (parseInt(parameters.get_process_value("Program_Nr")) == 3) {
        local_log("Mode 3");
        out_ProgrammingMode0.set(work_token, low);
        out_ProgrammingMode1.set(work_token, high);
    } else if (parseInt(parameters.get_process_value("Program_Nr")) == 4) {
        local_log("Mode 4");
        out_ProgrammingMode0.set(work_token, high);
        out_ProgrammingMode1.set(work_token, high);
    } else {
        local_log("Mode not supported");
    }
}

//===========================================================================
const get_local_log = (prefix) => {
    return msg => {
        log_message(moduleName + " >> " + prefix + " >> " + msg)
    }
}

//==============================================================================
const get_new_vector = (val_x, val_y) => {
    return { "x": val_x, "y": val_y }
}

//==============================================================================
async function wait_for_input_with_answer(work_token, input, level, timeout, caller) {
    const local_log = get_local_log(caller + " >> wait_for_input_with_answer " + input.get_name() + " " + level);

    const button_retry = context.message.button_retry();

    local_log("started");

    while (true) {
        const had_timeout = await input.wait_for_with_timeout_ms(work_token, level, timeout);
        if (!had_timeout) {
            //local_log("finished");
            return true;
        }
        local_log(" -->> IO timeout occured <<-- ");
        const debugInfo =
            input.get_name() +
            " not reached level = " +
            level +
            " in " +
            timeout +
            " ms. ";

        const strMessageText =
            moduleName + " Error:" +
            "\nModule is not ready." +
            "\nDetail information is shown on the display of the " + moduleName + ".\n" +
            "\nPress 'Retry' to check the input state and continue." +
            "\nPress 'Cancel' to cancle processing.\n" +
            "\nAdditional information:\n" +
            debugInfo
        local_log(strMessageText);

        const button = await context.message.show_error(
            work_token,
            strMessageText,
            button_retry
        );

        switch (button) {
            case button_retry:
                local_log("button RETRY pressed");
                break;
        }
    }
}

/*******************************************************************************
 * On Simulation
 ******************************************************************************/
context.on_simulation(async function (work_token, hardware_simulation) {
    const local_log = get_local_log("on_simulation");
    local_log("started");

    // IO Declaration
    const sim_out_Start = hardware_simulation.get_binary_pin_with_safety_constraints("Output_Start");
    const sim_out_Reset = hardware_simulation.get_binary_pin_with_safety_constraints("Output_Reset");
    const sim_out_PositioningSystemAway = hardware_simulation.get_binary_pin("Output_PositioningSystemAway");
    const sim_out_ProgrammingMode0 = hardware_simulation.get_binary_pin("Output_ProgrammingMode0");
    const sim_out_ProgrammingMode1 = hardware_simulation.get_binary_pin("Output_ProgrammingMode1");
    const sim_in_Ready = hardware_simulation.get_binary_pin("Input_Ready");
    const sim_in_ProcessDone = hardware_simulation.get_binary_pin("Input_CycleEnd");

    local_log("set after reset state");

    //===========================================================================
    async function simulationOnCleanUp(work_token) {
        local_log("simulationOnCleanUp started");

        sim_in_ProcessDone.set(work_token, low);

        await sim_out_Start.wait_for(work_token, low);
        await sim_out_PositioningSystemAway.wait_for(work_token, high);
        sim_in_Ready.set(work_token, low);
        await sim_out_Reset.wait_for(work_token, low);
        await context.opt.sleep_ms(work_token, 200);
        sim_in_Ready.set(work_token, high);
    }

    //===========================================================================
    async function simulationOnCycle(work_token) {
        local_log("simulationOnCycle");

        sim_in_Ready.set(work_token, low);
        await sim_out_Start.wait_for(work_token, low);

        //Simulated Process Time
        await context.opt.sleep_ms(work_token, 200);

        local_log("mark_as_processed");
        hardware_simulation.mark_as_processed(work_token);

        sim_in_ProcessDone.set(work_token, high);

        //Simulated Load Time
        await context.opt.sleep_ms(work_token, 400);

        //Set ready and processDone for next mil crimp
        local_log("module ready for next crimp");
        sim_in_Ready.set(work_token, high);
        sim_in_ProcessDone.set(work_token, low);
    }

    //===========================================================================
    while (true) {
        if (sim_out_Reset.get() == high) {
            await simulationOnCleanUp(work_token);
        }
        if (sim_out_Start.get() == high) {
            await simulationOnCycle(work_token);
        }
        await context.opt.sleep_ms(work_token, 10);
    }//end while

    local_log("finished");
})

