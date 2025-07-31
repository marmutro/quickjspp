#include "../quickjspp.hpp"
#include "quickjs/quickjs-libc.h"
#include "quickjs/quickjs.h"
#include <filesystem>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string_view>

namespace gmrt
{

void log_message(std::string_view s)
{
    //
    std::cout << "C++:\t" << s << std::endl;
}

void js_message(std::string_view s)
{
    //
    std::cout << "JS:\t" << s << std::endl;
}

using PromiseResolverPtr = std::shared_ptr<class PromiseResolver>;
class PromiseResolver
{
    JSContext* m_pContext = nullptr;

public:
    JSValue m_promise;
    JSValue m_resolving_funcs[2];
    static constexpr auto UseResolveFn = 0;
    static constexpr auto UseRejectFn = 1;

public:
    PromiseResolver(JSContext* pContext)
        : m_pContext(pContext)
    {
        auto promise = JS_NewPromiseCapability(m_pContext, m_resolving_funcs);
        if (JS_IsException(promise)) {
            throw qjs::exception{m_pContext};
        }
        m_promise = JS_DupValue(m_pContext, promise);
    }
    PromiseResolver(JSContext* pContext, JSValue promise)
        : m_pContext(pContext)
        , m_promise(JS_DupValue(m_pContext, promise))
    {
    }

    // no copy, no move
    PromiseResolver(const PromiseResolver&) = delete;
    PromiseResolver(PromiseResolver&&) = delete;
    PromiseResolver& operator=(const PromiseResolver&) = delete;
    PromiseResolver& operator=(PromiseResolver&&) = delete;

    void resolve(const qjs::Value* result)
    {
        log_message("PromiseResolver.resolve" + (result ? " result=" + result->toJSON() : " no result"));
        handle(result, UseResolveFn);
    }

    void reject(const qjs::Value* error)
    {
        log_message("PromiseResolver.reject" + (error ? " error=" + error->toJSON() : " no error"));
        handle(error, UseRejectFn);
    }

    ~PromiseResolver()
    {
        JS_FreeValue(m_pContext, m_resolving_funcs[0]);
        JS_FreeValue(m_pContext, m_resolving_funcs[1]);
        JS_FreeValue(m_pContext, m_promise);
    }

    JSValue getPromise() const
    {
        return m_promise;
    }

private:
    void handle(const qjs::Value* value, size_t resolveOrReject)
    {
        if (value == nullptr) {
            qjs::Value ret = JS_Call(m_pContext, m_resolving_funcs[resolveOrReject], JS_UNDEFINED, 0, nullptr);
            if (JS_IsException(ret.v)) {
                throw qjs::exception{m_pContext};
            }
        } else {
            JSValueConst cv = value->v;
            qjs::Value ret = JS_Call(m_pContext, m_resolving_funcs[resolveOrReject], JS_UNDEFINED, 1, &cv);
            if (JS_IsException(ret.v)) {
                throw qjs::exception{m_pContext};
            }
        }
    }
};

template <typename... Param>
class Task
{
public:
    explicit Task(const std::shared_ptr<PromiseResolver>& ptrResolver)
        : m_ptrResolver(ptrResolver)
    {
    }

    PromiseResolverPtr getResolver() const
    {
        return m_ptrResolver;
    }

    template <typename Continuation>
    static void then(JSContext* pContext, const PromiseResolverPtr& ptrResolver, Continuation continuation)
    {
        qjs::Context::get(pContext).enqueueJob([pContext, ptrResolver, cont = continuation] {
            try {
                if constexpr (std::is_same_v<decltype(cont()), void>) {
                    cont();
                    ptrResolver->resolve(nullptr);
                } else {
                    qjs::Value result{pContext, cont()};
                    ptrResolver->resolve(&result);
                }
            } catch (const std::exception& e) {
                qjs::Value error{pContext, e.what()};
                ptrResolver->reject(&error);
            }
        });
    }

private:
    std::shared_ptr<PromiseResolver> m_ptrResolver;
};

template <typename... Param>
using TaskPtr = std::shared_ptr<Task<Param...>>;
} // namespace gmrt

namespace qjs
{

/** Conversions for Tasks (promise). */

template <>
struct js_traits<gmrt::TaskPtr<>>
{
    static gmrt::TaskPtr<> unwrap(JSContext* ctx, JSValueConst v) noexcept
    {
        auto ptrPromise = std::make_shared<gmrt::PromiseResolver>(ctx, const_cast<JSValue&>(v));
        return std::make_shared<gmrt::Task<>>(ptrPromise);
    }

    static JSValue wrap(JSContext* ctx, gmrt::TaskPtr<> t) noexcept
    {
        return t->getResolver()->getPromise();
    }
};

template <typename T>
struct js_traits<gmrt::TaskPtr<T>>
{
    static gmrt::TaskPtr<T> unwrap(JSContext* ctx, JSValueConst v) noexcept
    {
        auto ptrPromise = std::make_shared<gmrt::PromiseResolver>(ctx, const_cast<JSValue&>(v));
        return std::make_shared<gmrt::Task<T>>(ptrPromise);
    }

    static JSValue wrap(JSContext* ctx, gmrt::TaskPtr<T> t) noexcept
    {
        return t->getResolver()->getPromise();
    }
};
} // namespace qjs

namespace gmrt
{

using WorkToken = int;

class BinaryPin
{
public:
    explicit BinaryPin(JSContext* pContext, std::string_view name)
        : m_pContext(pContext)
        , m_name{name}
    {
    }
    enum class State { Low, High, Illegal };

    TaskPtr<> set(const WorkToken& ptrWorkToken, State newState)
    {
        log_message("BinaryPin::set name=" + m_name + " worktoken=" + std::to_string(ptrWorkToken) +
                    " newState=" + std::to_string(static_cast<int>(newState)));
        auto ptrPromise = std::make_shared<PromiseResolver>(m_pContext);
        Task<>::then(m_pContext, ptrPromise, [ptrWorkToken, newState, this] {
            return setDone(ptrWorkToken, newState);
        });
        return std::make_shared<Task<>>(ptrPromise);
    }
    TaskPtr<> waitFor(const WorkToken& ptrWorkToken, State expectedState)
    {
        log_message("BinaryPin::waitFor " + m_name);
        auto ptrPromise = std::make_shared<PromiseResolver>(m_pContext);
        Task<>::then(m_pContext, ptrPromise, [] { return true; });
        return std::make_shared<Task<>>(ptrPromise);
    }
    TaskPtr<> waitForWithTimeoutMs(const WorkToken& ptrWorkToken, State expectedState, size_t timeout)
    {
        log_message("BinaryPin::waitForWithTimeoutMs " + m_name);
        auto ptrPromise = std::make_shared<PromiseResolver>(m_pContext);
        Task<>::then(m_pContext, ptrPromise, [] { return true; });
        return std::make_shared<Task<>>(ptrPromise);
    }

private:
    std::vector<double> setDone(const WorkToken& ptrWorkToken, State newState)
    {
        log_message("BinaryPin::setDone name=" + m_name + " worktoken=" + std::to_string(ptrWorkToken) +
                    " newState=" + std::to_string(static_cast<int>(newState)));
        if (newState == State::Illegal) {
            throw std::runtime_error{"illegal pin-state"};
        }
        return {1.1, 2.2, 3};
    }
    JSContext* m_pContext = nullptr;
    std::string m_name;
};

class Hardware
{
public:
    explicit Hardware(JSContext* pContext)
        : m_pContext(pContext)
        , m_pin{std::make_shared<BinaryPin>(pContext, "Demo-Output")}
    {
    }
    std::shared_ptr<BinaryPin> get_binary_pin_with_safety_constraints(std::string_view pinName)
    {
        log_message("Hardware::get_binary_pin_with_safety_constraints pinName=" + std::string{pinName});
        return m_pin;
    }

private:
    JSContext* m_pContext = nullptr;
    std::shared_ptr<BinaryPin> m_pin;
};

using CleanupFn = std::function<void(WorkToken)>;
class Context
{
public:
    Context(JSContext* pContext)
        : m_pContext(pContext)
        , m_ptrHardware{std::make_shared<gmrt::Hardware>(pContext)}
    {
    }

    void cleanup()
    {
        m_cleanupWithoutPowerFns.clear();
    }

    void on_clean_up_without_power(const CleanupFn& fn)
    {
        log_message("add fn to on_clean_up_without_power");
        m_cleanupWithoutPowerFns.push_back(fn);
    }

    void execute_on_cleanup_without_power()
    {
        log_message("calling on_clean_up_without_power fns");
        for (const auto& fn : m_cleanupWithoutPowerFns) {
            fn(1234);
        }
    }

    std::shared_ptr<gmrt::Hardware> m_ptrHardware;

private:
    JSContext* m_pContext = nullptr;
    std::vector<CleanupFn> m_cleanupWithoutPowerFns;
};

} // namespace gmrt

int main(int argc, char** argv)
{
    qjs::Runtime runtime;
    qjs::Context context(runtime);

    if (argc < 1 && not std::filesystem::exists(argv[1])) {
        exit(1);
    }
    try {

        gmrt::log_message("setup context");

        context.global().add("log_message", gmrt::js_message);
        context.global()["low"] = gmrt::BinaryPin::State::Low;
        context.global()["high"] = gmrt::BinaryPin::State::High;
        context.global()["illegal"] = gmrt::BinaryPin::State::Illegal;

        context.onUnhandledPromiseRejection = [](qjs::Value value) {
            gmrt::log_message("rejected promise=" + value.toJSON());
        };

        // export classes as a module
        auto& gmrtModule = context.addModule("gmrt");
        {
            // emulate KmxScripting TemplateProviderBuilder
            auto builder = gmrtModule.class_<gmrt::Context>(typeid(gmrt::Context).name());
            builder.fun<&gmrt::Context::m_ptrHardware>("hardware");
            builder.fun<&gmrt::Context::on_clean_up_without_power>("on_clean_up_without_power");
        }
        gmrtModule.class_<gmrt::Hardware>("Hardware")
            .fun<&gmrt::Hardware::get_binary_pin_with_safety_constraints>("get_binary_pin_with_safety_constraints");

        gmrtModule.class_<gmrt::BinaryPin>("BinaryPin")
            .fun<&gmrt::BinaryPin::set>("set")
            .fun<&gmrt::BinaryPin::waitFor>("waitFor")
            .fun<&gmrt::BinaryPin::waitForWithTimeoutMs>("waitForWithTimeoutMs");

        auto gmrtContext = std::make_shared<gmrt::Context>(context.ctx);
        context.global()["context"] = gmrtContext;

        gmrt::log_message("evaluate script " + std::string{argv[1]});
        context.evalFile(argv[1]);

        auto fun = (std::function<gmrt::TaskPtr<std::string>()>)context.global()["fun"];
        auto task = fun();

        auto resolve_fn = (std::function<void()>)context.global()["resolve_promise"];

        resolve_fn();
        // gmrt::Task<std::string>::then(context.ctx, task->getResolver(), []() { gmrt::log_message("continuation"); });

        gmrt::log_message("enqueue execute_on_cleanup_without_power");
        context.enqueueJob([&] { gmrtContext->execute_on_cleanup_without_power(); });

        while (runtime.isJobPending()) {
            gmrt::log_message("executePendingJob");
            runtime.executePendingJob();
        }

        gmrt::log_message("done executePendingJob");
        gmrtContext->cleanup();

    } catch (qjs::exception) {
        auto exc = context.getException();
        std::cerr << (std::string)exc << std::endl;
        if ((bool)exc["stack"])
            std::cerr << (std::string)exc["stack"] << std::endl;
        return 1;
    }
}
